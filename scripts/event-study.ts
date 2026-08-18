#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { createLogger } from '../src/core/logger.js';
import { multiplicitySummary, runEventStudy, type StudyEvent } from '../src/backtesting/event-study.js';
import {
  formatDuration,
  parseSymbolsFile,
  resolveUniverse,
  secFetchFloorSeconds,
} from '../src/backtesting/universe.js';
import { roundTripCostPercent } from '../src/execution/costs.js';
import { summariseEvidence, writeEvidenceFile } from '../src/strategy/evidence.js';
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
 *   npm run study -- --symbols-file universe.txt   one per line, # comments
 *   npm run study -- --benchmark QQQ
 *   npm run study -- --years 5 --out   write the evidence book the agent reads
 *
 * On universe size: more symbols is the cheapest way to buy statistical power,
 * because the sample and cluster bars a category must clear are counted over
 * the whole universe. It is also the slowest part of the run — see the request
 * floor printed before the filings are fetched.
 */

loadEnvFile();
const config = loadConfig();
const log = createLogger('study');

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  // `--out --years 5` must not read "--years" as the output path.
  return value && !value.startsWith('--') ? value : fallback;
}

const years = Number(arg('years', '2'));
const benchmark = arg('benchmark', 'SPY')!;

const symbolsFile = arg('symbols-file');
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

// Deduplicated deliberately: this script calls the SEC adapter directly, so it
// never passes through the ingestion deduplicator, and a repeated ticker would
// contribute its filings twice — straight into the sample and cluster counts
// the significance bars are checked against.
const { symbols, duplicates } = resolveUniverse(rawSymbols);

if (symbols.length === 0) {
  console.error('No symbols. Set WATCHLIST, or pass --symbols or --symbols-file.');
  process.exit(1);
}
if (duplicates.length > 0) {
  console.log(
    `  ${duplicates.length} duplicate symbol(s) removed: ${duplicates.slice(0, 12).join(', ')}` +
      `${duplicates.length > 12 ? ` (+${duplicates.length - 12})` : ''}`,
  );
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

// The budget is per ticker (see SecEdgarAdapter.fetchDocuments), and a large
// cap files hundreds of Form 4s a year, so five years needs real depth per
// name. A global cap divided by 40 symbols is how a study of 40 companies
// quietly became a study of 7.
const PER_SYMBOL_FILINGS = 1500;

// --symbols must drive the filings too, not only the prices: without this the
// study would price one set of companies and study the filings of another.
if ('setTickers' in secSource && typeof secSource.setTickers === 'function') {
  (secSource as unknown as { setTickers: (t: string[]) => void }).setTickers(symbols);
}

// A three-hundred-symbol run should be a decision, not a surprise: the SEC
// side alone is one request per symbol against a self-imposed 5/s.
console.log(
  `Fetching filings (up to ${PER_SYMBOL_FILINGS} per symbol) — ` +
    `${symbols.length} SEC request(s), at least ${formatDuration(secFetchFloorSeconds(symbols.length))} ` +
    'before the bars are even requested...',
);
const documents = await secSource.fetchDocuments({
  since,
  limit: symbols.length * PER_SYMBOL_FILINGS,
});

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

// Coverage first, because every number below is conditional on it. A study
// that silently covers a seventh of the requested universe is not a small
// version of the intended study — it is a study of different companies.
const symbolsWithEvents = new Set(events.map((event) => event.symbol));
const missing = symbols.filter((symbol) => !symbolsWithEvents.has(symbol));

console.log(`  ${documents.length} filings → ${events.length} usable events`);
console.log(
  `  covering ${symbolsWithEvents.size}/${symbols.length} requested symbol(s)` +
    (missing.length > 0 ? ` — NO filings for: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` (+${missing.length - 12})` : ''}` : ''),
);
if (symbolsWithEvents.size < symbols.length) {
  console.log('  !! Results below describe the covered symbols only, not the watchlist.\n');
} else {
  console.log('');
}

if (events.length === 0) {
  console.log('Nothing to study. Widen WATCHLIST or --years.\n');
  process.exit(0);
}

// --- Bars --------------------------------------------------------------------
console.log(`Fetching daily bars for ${symbols.length} symbol(s)...`);
const barsBySymbol = new Map<string, Bar[]>();
let priced = 0;
for (const symbol of symbols) {
  try {
    barsBySymbol.set(symbol, (await stack.marketData.getBars(symbol, '1Day', { start: since })).bars);
  } catch (err) {
    log.warn({ symbol, error: (err as Error).message }, 'no bars for symbol');
  }
  priced += 1;
  // Sequential by design, to respect the provider's limit. On a large universe
  // that is minutes of silence otherwise, which is indistinguishable from a hang.
  if (symbols.length > 20 && priced % 25 === 0) {
    console.log(`  ${priced}/${symbols.length} requested, ${barsBySymbol.size} priced`);
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
// Costs are taken from the position size this account would actually trade: a
// €1 commission is a rounding error on €50,000 and half the edge on €500.
const notional = (config.PAPER_CAPITAL_EUR * config.MAX_POSITION_PERCENT) / 100;
const roundTripCostPct = roundTripCostPercent(100, notional / 100);

console.log(
  `Cost model: ${roundTripCostPct}% round trip on a ${notional.toFixed(0)} ${config.BASE_CURRENCY} position.\n`,
);

const results = runEventStudy({
  events,
  barsBySymbol,
  roundTripCostPct,
  ...(benchmarkBars ? { benchmarkBars } : {}),
});

if (!benchmarkBars) {
  console.log('!! Returns below are RAW, not market-adjusted. A rising market will look like an edge.\n');
}

/**
 * A clustered standard error estimated from a handful of groups is not a small
 * number with wide error bars — it is arithmetic on nothing, and prints as
 * t=-235 on three observations. Showing a dash says that plainly; the verdict
 * already refuses to use it.
 */
const MIN_CLUSTERS_TO_PRINT_A_T = 5;
function clusteredT(horizon: { tStat: number; clusters: number }): string {
  return horizon.clusters < MIN_CLUSTERS_TO_PRINT_A_T ? '  n/a' : horizon.tStat.toFixed(2);
}

for (const result of results) {
  console.log(`=== ${result.category} ===`);
  console.log(`  observations           ${result.sampleSize}`);
  for (const horizon of result.horizons) {
    if (horizon.sampleSize === 0) continue;
    console.log(
      `  +${String(horizon.sessions).padEnd(2)}d  mean ${horizon.meanAbnormalPct.toFixed(3).padStart(8)}%  ` +
        `net ${horizon.meanNetOfCostsPct.toFixed(3).padStart(8)}%  ` +
        `hit ${(horizon.hitRate * 100).toFixed(1).padStart(5)}%  ` +
        `t ${clusteredT(horizon).padStart(6)}${horizon.survivesMultiplicity ? '*' : ' '} (naive ${horizon.naiveTStat.toFixed(2)})  ` +
        `n=${horizon.sampleSize} over ${horizon.clusters} sym` +
        (horizon.largestClusterShare >= 0.3
          ? `, busiest ${(horizon.largestClusterShare * 100).toFixed(0)}%`
          : ''),
    );
  }
  console.log(`  -> ${result.verdict}\n`);
}

const multiplicity = multiplicitySummary(results);
console.log(
  `Multiplicity: ${multiplicity.tested} tests run, ${multiplicity.nominal} crossed |t|=1.96, ` +
    `${multiplicity.survivors} survived false-discovery control at q=0.10.`,
);
if (multiplicity.nominal > multiplicity.survivors) {
  const expectedByChance = (multiplicity.tested * 0.05).toFixed(0);
  console.log(
    `  At a 5% per-test cutoff, ~${expectedByChance} of ${multiplicity.tested} would cross from noise alone` +
      `${multiplicity.survivors === 0 ? ' — which is what happened here.' : '.'}`,
  );
}
console.log('');

console.log('Reading these numbers:');
console.log(`  "net" subtracts a ${roundTripCostPct}% modelled round trip. A gross mean smaller`);
console.log('  than that is not an edge, however significant it is.');
console.log('  "t" is clustered by symbol: filings from one company are not independent');
console.log('  observations, and at +20d their windows overlap. The naive t in brackets');
console.log('  is what treating them as independent would have claimed.');
console.log('  A trailing * marks a test that survived false-discovery control across');
console.log('  every test this run made. Crossing |t|=1.96 alone means little here:');
console.log('  at a hundred tests, five or six cross it from noise alone.');
console.log('  A surviving result is permission to test properly — never a reason');
console.log('  to trade.\n');

// --- Evidence book -----------------------------------------------------------
// Written only when asked for. What the agent does with it is one-sided: a
// category measured drifting against a long is refused, and nothing in the file
// can license a trade.
const out = args.includes('--out') ? (arg('out') ?? config.EVIDENCE_FILE) : undefined;
if (out) {
  const book = summariseEvidence(results, {
    generatedAt: new Date().toISOString(),
    windowYears: years,
    ...(benchmarkBars ? { benchmark } : {}),
    roundTripCostPct,
    symbols: barsBySymbol.size,
  });
  writeEvidenceFile(out, book);

  const blocked = book.categories.filter((c) => c.status === 'adverse');
  console.log(`Evidence book written to ${out}.`);
  console.log(
    blocked.length === 0
      ? '  Nothing measured drifting against a long, so the agent gains no new veto.\n'
      : `  The agent will now refuse: ${blocked.map((c) => `${c.category} (${c.eventType ?? 'unmapped'})`).join(', ')}\n`,
  );
}

process.exit(0);
