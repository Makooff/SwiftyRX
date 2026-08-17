#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { createLogger } from '../src/core/logger.js';
import { AgentStateStore, StateMismatchError } from '../src/database/agent-state-store.js';
import { startApiServer } from '../apps/api/server.js';
import { TradingAgent } from '../apps/worker/agent.js';

/**
 * Continuous paper trading.
 *
 *   npm run paper                 loop + dashboard on http://127.0.0.1:3000
 *   npm run paper -- --once       a single cycle, then exit
 *   npm run paper -- --no-server  loop without the dashboard
 *   npm run paper -- --fresh      ignore any saved state and start over
 *
 * Refuses to start in live mode: this entry point is for simulation, and a
 * command named "paper" must never be the thing that trades real money.
 */

loadEnvFile();
const config = loadConfig();
const log = createLogger('paper');

if (config.isLive) {
  console.error(
    '\nRefusing to run: MODE=live.\n' +
      "`npm run paper` is the simulation entry point and will not trade real money.\n" +
      'Live trading is Phase 9 and is not implemented.\n',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const once = args.includes('--once');
const withServer = !args.includes('--no-server');
const fresh = args.includes('--fresh');
const port = Number(process.env.DASHBOARD_PORT ?? 3000);

// Persistence is on by default. The point of a continuous paper run is to
// accumulate a track record, and a portfolio that resets on every restart
// cannot produce one.
const stateStore = fresh ? undefined : new AgentStateStore();

let agent: TradingAgent;
try {
  agent = new TradingAgent({ config, ...(stateStore ? { stateStore } : {}) });
} catch (err) {
  if (err instanceof StateMismatchError) {
    console.error(`\n${err.message}\n`);
    console.error('Or run `npm run paper -- --fresh` to start a new run without touching it.\n');
    process.exit(1);
  }
  throw err;
}

console.log('\n=== AI Market Agent — paper trading ===\n');
console.log(`  mode                ${config.MODE} (no real money)`);
console.log(`  capital             ${config.initialCapital} ${config.BASE_CURRENCY}`);
console.log(`  watchlist           ${config.WATCHLIST.join(', ')}`);
console.log(`  LLM provider        ${agent.getLlmProviderId()}`);
console.log(`  cycle interval      ${config.INGEST_INTERVAL_SECONDS}s`);
console.log(`  state               ${stateStore ? stateStore.path : 'not persisted (--fresh)'}`);

if (agent.getState().cycles > 0) {
  console.log(
    `\n  Resumed: ${agent.getState().cycles} previous cycles, ` +
      `${agent.portfolio.trades.length} closed trades, ` +
      `value ${agent.portfolio.totalValue.toFixed(2)} ${config.BASE_CURRENCY}.`,
  );
}

if (agent.getLlmProviderId() === 'none') {
  console.log(
    '\n  Note: no LLM configured, so events will be detected and verified but no signals\n' +
      '  generated. Set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY to enable analysis.',
  );
}

console.log('\nChecking data sources...');
for (const report of await agent.refreshHealth()) {
  console.log(`  [${report.state.padEnd(11)}] ${report.adapter}${report.detail ? ` — ${report.detail}` : ''}`);
}

if (withServer) {
  await startApiServer({ agent, config, port });
  console.log(`\nDashboard: http://127.0.0.1:${port}\n`);
}

let running = true;
const stop = (signal: string) => {
  log.info({ signal }, 'shutting down');
  running = false;
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

let since = new Date(Date.now() - 6 * 3600 * 1000);
// Set to today at startup so a restart does not re-post yesterday's summary.
let lastSummaryDay = new Date().toISOString().slice(0, 10);

do {
  const cycleStart = new Date();
  try {
    await agent.runCycle({ since });
    since = cycleStart;

    const state = agent.getState();
    log.info(
      {
        cycle: state.cycles,
        documents: state.documentsIngested,
        events: state.eventsDetected,
        signals: state.signalsGenerated,
        orders: state.ordersPlaced,
        riskRejections: state.ordersRejectedByRisk,
        portfolioValue: agent.portfolio.totalValue,
        returnPct: agent.portfolio.totalReturnPct,
        drawdownPct: agent.portfolio.drawdownPct,
        halted: state.halted,
      },
      'cycle complete',
    );
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cycle failed');
  }

  if (once || !running) break;

  // Health is refreshed once per cycle so the dashboard reflects reality
  // rather than the state at startup.
  await agent.refreshHealth();

  // One Discord summary per day, on the first cycle after the date rolls.
  // Anything more frequent is noise, and noise is what stops notifications
  // being read at all.
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastSummaryDay) {
    lastSummaryDay = today;
    await agent.postSummary();
  }

  const elapsed = Date.now() - cycleStart.getTime();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1000, config.INGEST_INTERVAL_SECONDS * 1000 - elapsed)),
  );
} while (running);

console.log('\n--- final portfolio ---');
console.log(`  value           ${agent.portfolio.totalValue.toFixed(2)} ${config.BASE_CURRENCY}`);
console.log(`  return          ${agent.portfolio.totalReturnPct.toFixed(2)}%`);
console.log(`  max drawdown    ${agent.portfolio.maxDrawdown.toFixed(2)}%`);
console.log(`  closed trades   ${agent.portfolio.trades.length}`);
console.log('');

process.exit(0);
