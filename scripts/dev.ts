#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { createLogger } from '../src/core/logger.js';
import { metrics } from '../src/monitoring/metrics.js';
import { buildIngestionStack, checkStackHealth, runIngestionCycle } from '../src/ingestion/pipeline.js';

/**
 * Development runner.
 *
 * At Phase 1 this is the ingestion loop and nothing more: fetch, normalise,
 * deduplicate, report. No signals are generated and no orders exist yet.
 */

loadEnvFile();
const config = loadConfig();
const log = createLogger('dev');

log.info(
  {
    mode: config.MODE,
    paperTrading: config.PAPER_TRADING,
    liveTrading: config.LIVE_TRADING,
    watchlist: config.WATCHLIST,
    intervalSeconds: config.INGEST_INTERVAL_SECONDS,
  },
  'starting ingestion loop (Phase 1 — ingestion only)',
);

const stack = buildIngestionStack(config);

const health = await checkStackHealth(stack);
for (const report of health) {
  const level = report.state === 'unavailable' ? 'warn' : 'info';
  log[level](
    { adapter: report.adapter, state: report.state, detail: report.detail },
    'source health',
  );
}

let running = true;
const stop = (signal: string) => {
  log.info({ signal }, 'shutting down');
  running = false;
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

let lastRunAt = new Date(Date.now() - 6 * 3600 * 1000);

while (running) {
  const cycleStart = new Date();
  try {
    const { stats } = await runIngestionCycle(stack, { since: lastRunAt, limitPerSource: 50 });
    lastRunAt = cycleStart;
    log.info(
      {
        fetched: stats.fetched,
        kept: stats.kept,
        exactDuplicates: stats.exactDuplicates,
        nearDuplicates: stats.nearDuplicates,
        failures: stats.failures.length,
        durationMs: stats.durationMs,
      },
      'ingestion cycle complete',
    );
    for (const failure of stats.failures) {
      log.warn({ adapter: failure.adapter, error: failure.error }, 'adapter failed this cycle');
    }
  } catch (err) {
    log.error({ error: (err as Error).message }, 'ingestion cycle failed');
  }

  const elapsed = Date.now() - cycleStart.getTime();
  const waitMs = Math.max(1000, config.INGEST_INTERVAL_SECONDS * 1000 - elapsed);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

log.info({ metrics: metrics.snapshot() }, 'final metrics');
process.exit(0);
