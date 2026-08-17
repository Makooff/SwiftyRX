#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { createLogger } from '../src/core/logger.js';
import { runEventStudy, type StudyEvent } from '../src/backtesting/event-study.js';
import { buildIngestionStack } from '../src/ingestion/pipeline.js';
import type { Bar } from '../src/domain/types.js';

/**
 * `npm run study` — does a class of filing carry any information at all?
 *
 * The backtest engine measures a strategy. Its only strategies are a
 * moving-average crossover and buy & hold, neither of which is what this
 * project built, so nothing had ever measured whether an SEC filing of a given
 * type is followed by an abnormal move.
 *
 * That question comes first and is far cheaper to answer: it needs no LLM calls
 * at all. If earnings filings are followed by no abnormal drift, no downstream
 * cleverness can extract an edge from them.
 *
 *   npm run study                      watchlist, 2 years, vs SPY
 *   npm run study -- --years 5
 *   npm run study -- --symbols AAPL,MSFT
 *   npm run study -- --benchmark QQQ
 */

loadEnvFile();
const config = loadConfig();
const log = createLogger('study');

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const years = Number(arg('years', '2'));
const benchmark = arg('benchmark', 'SPY')!;
const symbols = (arg('symbols') ?? config.WATCHLIST.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

if (symbols.length === 0) {
  console.error('No symbols. Set WATCHLIST or pass --symbols.');
  process.exit(1);
}

const since = new Date(Date.now() - years * 365 * 86_400_000);
const stack = buildIngestionStack(config);

console.log(`\n=== Event study — ${symbols.length} symbol(s), ${years}y, abnormal vs ${benchmark} ===\n`);

// --- Filings -----------------------------------------------------------------
const secSource = stack.documentSources.find((s) => s.id === 'sec_edgar');
if (!secSource) {
  console.error('SEC EDGAR is not configured. Set CONTACT_EMAIL — the SEC requires it.');
  process.exit(1);
}

console.log('Fetching filings...');
const documents = await secSource.fetchDocuments({ since, limit: 5000 });

const events: StudyEvent[] = [];
for (const doc of documents) {
  const form = String((doc.metadata as { form?: string }).form ?? '').trim();
  const items = ((doc.metadata as { items?: string[] }).items ?? []) as string[];
  const symbol = doc.tickers[0];
  // A filing with no publication timestamp cannot be placed on a calendar, so
  // it cannot be studied — dropping it beats guessing a date.
  if (!symbol || !form || !doc.published_at) continue;

  // 8-K item codes are the issuer's own statement of what the filing is about,
  // so they make far sharper categories than the form alone.
  const category = form === '8-K' && items.length > 0 ? `8-K item ${items[0]}` : form;
  events.push({ symbol, at: doc.published_at, category });
}

console.log(`  ${documents.length} filings → ${events.length} usable events\n`);

if (events.length === 0) {
  console.log('Nothing to study. Widen WATCHLIST or --years.\n');
  process.exit(0);
}

// --- Bars --------------------------------------------------------------------
console.log('Fetching daily bars...');
const barsBySymbol = new Map<string, Bar[]>();
for (const symbol of symbols) {
  try {
    barsBySymbol.set(symbol, (await stack.marketData.getBars(symbol, '1Day', { start: since })).bars);
  } catch (err) {
    log.warn({ symbol, error: (err as Error).message }, 'no bars for symbol');
  }
}

let benchmarkBars: Bar[] | undefined;
try {
  benchmarkBars = (await stack.marketData.getBars(benchmark, '1Day', { start: since })).bars;
} catch (err) {
  // Without it every result is contaminated by whatever the market did, so
  // this is reported rather than silently skipped.
  log.warn({ benchmark, error: (err as Error).message }, 'no benchmark bars — results will NOT be market-adjusted');
}

console.log(`  ${barsBySymbol.size} symbol(s) priced${benchmarkBars ? `, benchmark ${benchmark} loaded` : ', NO BENCHMARK'}\n`);

// --- Study -------------------------------------------------------------------
const results = runEventStudy({
  events,
  barsBySymbol,
  ...(benchmarkBars ? { benchmarkBars } : {}),
});

if (!benchmarkBars) {
  console.log('!! Returns below are RAW, not market-adjusted. A rising market will look like an edge.\n');
}

for (const result of results) {
  console.log(`=== ${result.category} ===`);
  console.log(`  observations           ${result.sampleSize}`);
  for (const horizon of result.horizons) {
    if (horizon.sampleSize === 0) continue;
    console.log(
      `  +${String(horizon.sessions).padEnd(2)}d  mean ${horizon.meanAbnormalPct.toFixed(3).padStart(8)}%  ` +
        `median ${horizon.medianAbnormalPct.toFixed(3).padStart(8)}%  ` +
        `hit ${(horizon.hitRate * 100).toFixed(1).padStart(5)}%  ` +
        `t ${horizon.tStat.toFixed(2).padStart(6)}  n=${horizon.sampleSize}`,
    );
  }
  console.log(`  -> ${result.verdict}\n`);
}

console.log('Reading these numbers:');
console.log('  A mean without a t-statistic is an anecdote. |t| below ~2 is noise.');
console.log('  Nothing here accounts for costs, slippage or capacity, so a positive');
console.log('  result is permission to test properly — never a reason to trade.\n');

process.exit(0);
