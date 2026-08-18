#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import { buildIngestionStack, runIngestionCycle } from '../src/ingestion/pipeline.js';
import { detectEvents, evaluateAnalysisGate } from '../src/intelligence/pipeline.js';
import { MemoryEventStore } from '../src/intelligence/event-store.js';

/**
 * One full Phase 1 + Phase 2 pass: ingest, then detect and verify events.
 *
 * Stops at verified events. No signal is produced and nothing is traded —
 * that is Phase 3 onward.
 */

loadEnvFile();
const config = loadConfig();

const lookbackHours = Number(process.env.INGEST_LOOKBACK_HOURS ?? 48);
const since = new Date(Date.now() - lookbackHours * 3600 * 1000);

const stack = buildIngestionStack(config);
const store = new MemoryEventStore();

console.log(`\nIngesting documents published since ${since.toISOString()}`);
const { documents, stats: ingestStats } = await runIngestionCycle(stack, { since, limitPerSource: 100 });
console.log(`  ${ingestStats.kept} documents kept from ${ingestStats.fetched} fetched`);
if (ingestStats.failures.length > 0) {
  console.log(`  ${ingestStats.failures.length} source(s) failed:`);
  for (const failure of ingestStats.failures) console.log(`    ${failure.adapter}: ${failure.error}`);
}

const { events, stats } = await detectEvents(documents, store, {
  // Market-reaction measurement is opt-in: it costs API calls and, on free
  // data plans, the history often is not there.
  ...(process.env.MEASURE_MARKET_REACTION === 'true' ? { marketData: stack.marketData } : {}),
});

console.log('\n--- detection summary ---');
console.log(`  documents in        ${stats.documents}`);
console.log(`  events detected     ${stats.clusters} (${stats.newEvents} new, ${stats.updatedEvents} updated)`);
console.log(`  contradicted        ${stats.contradicted}`);
console.log(`  duration            ${stats.durationMs}ms`);

if (Object.keys(stats.byType).length > 0) {
  console.log('\n--- by event type ---');
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(22)} ${count}`);
  }
  console.log('\n--- by verification status ---');
  for (const [status, count] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(22)} ${count}`);
  }
}

const top = events.slice(0, 10);
if (top.length > 0) {
  console.log('\n--- highest-materiality events ---');
  for (const event of top) {
    console.log(`\n  [${event.type}] materiality=${event.materiality} confidence=${event.verification.confidence}`);
    console.log(`  ${event.headline.slice(0, 110)}`);
    console.log(`  status: ${event.verification.status}  sources: ${event.sources.join(', ')}`);
    if (event.tickers.length > 0) console.log(`  tickers: ${event.tickers.join(', ')}`);
    if (event.entities.length > 0) {
      console.log(`  entities: ${event.entities.slice(0, 5).map((e) => `${e.id ?? e.text}(${e.confidence})`).join(', ')}`);
    }
    console.log(`  rules: ${event.classification.matched.slice(0, 3).map((r) => r.rule).join(', ') || 'none'}`);
    console.log(`  why: ${event.verification.reasons.join('; ')}`);
    if (event.verification.contradictions.length > 0) {
      console.log(`  CONTRADICTED: ${event.verification.contradictions.map((c) => c.matchedPattern).join(', ')}`);
    }
  }
}

const { kept: worthAnalysing, droppedByReason } = evaluateAnalysisGate(events);
console.log(
  `\n${worthAnalysing.length} of ${events.length} events clear the materiality and confidence floors ` +
    'and would be passed to Phase 3 analysis.',
);
for (const [reason, count] of Object.entries(droppedByReason)) {
  console.log(`  dropped: ${count} ${reason}`);
}
console.log('');
