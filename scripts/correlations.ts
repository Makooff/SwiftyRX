#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { createLogger } from '../src/core/logger.js';
import { parseSymbolsFile, resolveUniverse } from '../src/backtesting/universe.js';
import { buildIngestionStack } from '../src/ingestion/pipeline.js';
import {
  CorrelationGroups,
  DEFAULT_THRESHOLD,
  MIN_SHARED_SESSIONS,
  estimateGroups,
  writeCorrelationFile,
} from '../src/risk/correlation.js';
import type { Bar } from '../src/domain/types.js';

/**
 * `npm run correlations` — which of the names we trade are the same bet?
 *
 * The Risk Engine caps exposure to any one correlated group, reading the group
 * as a label on the order and on each held position. Nothing produced that
 * label, so the cap never applied to anything. This measures the groups from
 * returns and writes the file the agent reads at startup.
 *
 *   npm run correlations                        watchlist, 1 year
 *   npm run correlations -- --days 500
 *   npm run correlations -- --symbols-file universe.txt
 *   npm run correlations -- --threshold 0.8     stricter joining
 *   npm run correlations -- --out               write CORRELATION_FILE
 *
 * Needs no LLM and no key beyond the market-data provider already configured.
 */

loadEnvFile();
const config = loadConfig();
const log = createLogger('correlations');

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

const days = Number(arg('days', '365'));
const threshold = Number(arg('threshold', String(DEFAULT_THRESHOLD)));
const symbolsFile = arg('symbols-file');

if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number.');
  process.exit(1);
}
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
  console.error('--threshold must be between 0 and 1.');
  process.exit(1);
}

let rawSymbols: string[];
if (symbolsFile) {
  try {
    rawSymbols = parseSymbolsFile(readFileSync(symbolsFile, 'utf8'));
  } catch (err) {
    console.error(`Could not read --symbols-file ${symbolsFile}: ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  rawSymbols = (arg('symbols') ?? config.WATCHLIST.join(',')).split(',');
}

const { symbols, duplicates } = resolveUniverse(rawSymbols);
if (symbols.length < 2) {
  console.error('Need at least two symbols to measure a correlation.');
  process.exit(1);
}

console.log(`\n=== Correlation groups — ${symbols.length} symbol(s), ${days}d, |r| >= ${threshold} ===\n`);
if (duplicates.length > 0) {
  console.log(`  ${duplicates.length} duplicate symbol(s) removed: ${duplicates.join(', ')}`);
}

const since = new Date(Date.now() - days * 86_400_000);
const stack = buildIngestionStack(config);

console.log(`Fetching daily bars for ${symbols.length} symbol(s)...`);
const barsBySymbol = new Map<string, Bar[]>();
let requested = 0;
for (const symbol of symbols) {
  try {
    barsBySymbol.set(symbol, (await stack.marketData.getBars(symbol, '1Day', { start: since })).bars);
  } catch (err) {
    log.warn({ symbol, error: (err as Error).message }, 'no bars for symbol');
  }
  requested += 1;
  if (symbols.length > 20 && requested % 25 === 0) {
    console.log(`  ${requested}/${symbols.length} requested, ${barsBySymbol.size} priced`);
  }
}

const unpriced = symbols.filter((symbol) => !barsBySymbol.has(symbol));
console.log(`  ${barsBySymbol.size}/${symbols.length} priced`);
if (unpriced.length > 0) {
  // Named, because a symbol with no bars is a symbol the limit will not
  // constrain — silence here would recreate the hole this script closes.
  console.log(
    `  !! NO bars, so NO group: ${unpriced.slice(0, 15).join(', ')}` +
      `${unpriced.length > 15 ? ` (+${unpriced.length - 15})` : ''}`,
  );
}

if (barsBySymbol.size < 2) {
  console.error('\nFewer than two symbols could be priced. Nothing to correlate.\n');
  process.exit(1);
}

const groups = estimateGroups(barsBySymbol, { threshold });
const book = CorrelationGroups.fromFile({
  generatedAt: new Date().toISOString(),
  windowDays: days,
  threshold,
  minObservations: MIN_SHARED_SESSIONS,
  groups,
});

console.log('\n--- groups ---\n');
for (const { group, symbols: members } of book.clusters) {
  const label = members.length > 1 ? `${group} (${members.length})` : group;
  console.log(`  ${label.padEnd(24)} ${members.join(', ')}`);
}

const grouped = book.clusters.filter((cluster) => cluster.symbols.length > 1);
console.log(
  `\n  ${book.clusters.length} group(s) from ${book.symbolCount} symbol(s); ` +
    `${grouped.length} contain more than one name.`,
);
console.log(
  `  A pair needed ${MIN_SHARED_SESSIONS} shared sessions to be compared at all, over a ${days}d window.`,
);
console.log(
  '\n  Correlations are estimated on one past window and rise toward one in a sell-off,\n' +
    '  which is exactly when this limit matters. Treat the groups as a floor on how\n' +
    '  concentrated the book is, never as the whole of it.\n',
);

if (args.includes('--out')) {
  const path = arg('out', config.CORRELATION_FILE)!;
  writeCorrelationFile(path, book.file);
  console.log(`  Written to ${path} — the agent reads it at startup.\n`);
} else {
  console.log('  Nothing written. Add --out to save it for the agent.\n');
}
