#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { metrics } from '../src/monitoring/metrics.js';
import { buildIngestionStack, runIngestionCycle } from '../src/ingestion/pipeline.js';

/**
 * Run one ingestion cycle and print what came back.
 *
 * Phase 1 stops here on purpose: documents are fetched, normalised and
 * deduplicated. No event detection, no LLM, no signals, no orders.
 */

loadEnvFile();
const config = loadConfig();

const lookbackHours = Number(process.env.INGEST_LOOKBACK_HOURS ?? 24);
const since = new Date(Date.now() - lookbackHours * 3600 * 1000);

const stack = buildIngestionStack(config);

console.log(`\nIngesting documents published since ${since.toISOString()}`);
console.log(`Sources: ${stack.documentSources.map((s) => s.id).join(', ') || 'none configured'}\n`);

const { documents, stats } = await runIngestionCycle(stack, { since, limitPerSource: 50 });

console.log('--- summary ---');
console.log(`  fetched            ${stats.fetched}`);
console.log(`  kept               ${stats.kept}`);
console.log(`  exact duplicates   ${stats.exactDuplicates} (dropped)`);
console.log(`  near duplicates    ${stats.nearDuplicates} (kept and linked — corroboration signal)`);
console.log(`  duration           ${stats.durationMs}ms`);

if (Object.keys(stats.bySource).length > 0) {
  console.log('\n--- by source ---');
  for (const [source, count] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source.padEnd(34)} ${count}`);
  }
}

if (stats.failures.length > 0) {
  console.log('\n--- failures ---');
  for (const failure of stats.failures) console.log(`  ${failure.adapter}: ${failure.error}`);
}

const sample = documents
  .slice()
  .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
  .slice(0, 10);

if (sample.length > 0) {
  console.log('\n--- most recent documents ---');
  for (const doc of sample) {
    console.log(`\n  [${doc.sourceTier}] ${doc.source}  reliability=${doc.source_reliability}`);
    console.log(`  ${doc.published_at ?? 'undated'}  ${doc.title.slice(0, 110)}`);
    if (doc.tickers.length > 0) console.log(`  tickers: ${doc.tickers.join(', ')}`);
    console.log(`  verification: ${doc.verification}${doc.duplicateOf ? ` (near-dup of ${doc.duplicateOf})` : ''}`);
  }
}

// Market data spot check on the first watchlist symbol, if any provider is up.
const symbol = config.WATCHLIST[0];
if (symbol && stack.marketData.configuredProviders.length > 0) {
  console.log(`\n--- market data check: ${symbol} ---`);
  try {
    const result = await stack.marketData.getQuote(symbol);
    console.log(
      `  ${result.quote.symbol} last=${result.quote.last ?? 'n/a'} ` +
        `bid=${result.quote.bid ?? 'n/a'} ask=${result.quote.ask ?? 'n/a'} ` +
        `via ${result.provider} (age ${Math.round(result.ageSeconds)}s, ${result.quote.freshness.delayClass})`,
    );
  } catch (err) {
    console.log(`  no usable quote: ${(err as Error).message}`);
  }
}

console.log('\n--- metrics ---');
console.log(JSON.stringify(metrics.snapshot(), null, 2));
console.log('');
