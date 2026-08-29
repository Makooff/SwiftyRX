#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { blockingGate, DecisionJournal } from '../src/database/decision-journal.js';

/**
 * Why did nothing trade?
 *
 *   npm run why              the whole journal
 *   npm run why -- --last 20 the last 20 decisions, one line each
 *
 * A run that analyses events and journals decisions without ever placing an
 * order looks identical from the outside to a run that is broken. It is
 * usually neither: some gate refused every candidate, and the gate said so at
 * the time. The journal already holds that answer — every decision is
 * recorded, including the ones that produced no order, with the risk verdict
 * and the rules that fired.
 *
 * This reads it back and counts. It spends no tokens, places no orders and
 * needs no network: it is a report on decisions already made.
 */

loadEnvFile();
const config = loadConfig();

const args = process.argv.slice(2);
const lastIndex = args.indexOf('--last');
const lastN = lastIndex >= 0 ? Number(args[lastIndex + 1] ?? 10) : 0;

const journal = new DecisionJournal();
const entries = await journal.readAll();

if (entries.length === 0) {
  console.log('\nThe journal is empty — no decision has been recorded yet.\n');
  console.log('Nothing has reached the analysis stage. That is an ingestion or');
  console.log('detection question, not a trading one: check `npm run sources:check`');
  console.log('and `npm run doctor` before looking any further down the funnel.\n');
  process.exit(0);
}

const counts = new Map<string, number>();
const scoresRefusedForScore: number[] = [];
for (const entry of entries) {
  const reason = blockingGate(entry);
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
  if (reason.includes('min_score')) scoresRefusedForScore.push(entry.score);
}

const traded = counts.get('traded') ?? 0;

console.log(`\n=== Why nothing traded — ${entries.length} journalled decisions ===\n`);
console.log(`  mode                      ${config.MODE}`);
console.log(`  min signal score          ${config.MIN_SIGNAL_SCORE}`);
console.log(
  `  model may pick the asset  ${config.ALLOW_MODEL_CHOSEN_ASSET ? 'yes' : 'no'}`,
);
console.log(`  tradable universe         ${config.tradableUniverse.join(', ') || '(none)'}`);
console.log(`  observation-only sources  ${config.OBSERVATION_ONLY_SOURCES.join(', ') || '(none)'}`);

console.log('\n--- where each decision stopped ---');
const width = Math.max(...[...counts.keys()].map((r) => r.length));
for (const [reason, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((count / entries.length) * 100).toFixed(0).padStart(3);
  console.log(`  ${reason.padEnd(width)}  ${String(count).padStart(4)}  ${pct}%`);
}

console.log('\n--- what to change ---');
if (traded > 0) {
  console.log(`  ${traded} decision(s) did become an order. The pipeline works end to end.`);
}

const noAsset = counts.get('model named no asset (WATCH/HOLD + NONE)') ?? 0;
if (noAsset > 0 && !config.ALLOW_MODEL_CHOSEN_ASSET) {
  console.log(
    `  ${noAsset} decision(s) named no asset. Set ALLOW_MODEL_CHOSEN_ASSET=true and the`,
  );
  console.log('  model is shown your universe and asked which listed symbol the story reaches.');
} else if (noAsset > 0) {
  console.log(
    `  ${noAsset} decision(s) named no asset despite the setting being on. Check that your`,
  );
  console.log('  WATCHLIST is wide enough to contain something these stories plausibly move.');
}

if (scoresRefusedForScore.length > 0) {
  const sorted = [...scoresRefusedForScore].sort((a, b) => b - a);
  const best = sorted[0]!;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `  ${sorted.length} refused on score alone. Best was ${best.toFixed(3)}, median ${median.toFixed(3)},`,
  );
  console.log(`  against a bar of ${config.MIN_SIGNAL_SCORE}. MIN_SIGNAL_SCORE just under the best`);
  console.log('  score above would have let the strongest of them through — and only those.');
}

const noPrice = counts.get('no price — no symbol resolved, or the quote failed') ?? 0;
if (noPrice > 0) {
  console.log(`  ${noPrice} had no price. That is a market-data problem, not a threshold one:`);
  console.log('  run `npm run doctor` and check the quote feed and MAX_QUOTE_STALENESS_SECONDS.');
}

if (counts.size === 1 && traded === entries.length) {
  console.log('  Nothing is blocking. Every journalled decision traded.');
}

if (lastN > 0) {
  console.log(`\n--- last ${Math.min(lastN, entries.length)} decisions ---`);
  for (const entry of entries.slice(-lastN).reverse()) {
    console.log(
      `  ${entry.timestamp.slice(0, 16)}  ${entry.signal.padEnd(5)} ${entry.asset.padEnd(6)} ` +
        `score ${entry.score.toFixed(3)}  ${blockingGate(entry)}`,
    );
    console.log(`      ${entry.eventHeadline.slice(0, 96)}`);
  }
}

console.log('');
