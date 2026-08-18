import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import {
  buildOutcome,
  DecisionJournal,
  isDirectional,
  isEvaluable,
  outcomeDueAt,
  type JournalEntry,
} from '../src/database/decision-journal.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { IngestionStack } from '../src/ingestion/pipeline.js';
import type { DocumentSource } from '../src/ingestion/types.js';
import type { LLMProvider } from '../src/intelligence/llm/types.js';
import type { Signal } from '../src/strategy/signals/types.js';

/**
 * Outcome tracking.
 *
 * The journal recorded what the system decided and never whether it was right,
 * so `hitRateByEventType()` — which is fed to the model before every new
 * signal — was quoting a rate computed from nothing. These tests pin the two
 * properties that make the loop trustworthy: an outcome is only claimed when
 * the horizon has genuinely elapsed, and completing a decision never rewrites
 * the line that recorded it.
 */

const clock = FixedClock.at('2026-08-18T12:00:00Z');

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    createdAt: clock.now().toISOString(),
    eventId: 'evt-1',
    asset: 'AAPL',
    action: 'BUY',
    modelConfidence: 0.8,
    score: 0.7,
    expectedHorizon: '1-5d',
    impact: 'positive',
    impactStrength: 0.8,
    reason: 'because',
    catalyst: 'earnings',
    uncertainties: [],
    likelyPricedIn: false,
    manipulationSuspected: false,
    sources: ['sec_edgar'],
    components: [],
    priceAtSignal: 100,
    provenance: { provider: 'test', model: 'test', latencyMs: 1 },
    ...overrides,
  };
}

async function journalWith(signals: Signal[]): Promise<{ journal: DecisionJournal; path: string }> {
  const path = join(await mkdtemp(join(tmpdir(), 'journal-')), 'decisions.jsonl');
  const journal = new DecisionJournal({ path, clock });
  for (const s of signals) {
    await journal.record({
      signal: s,
      eventType: 'earnings',
      eventHeadline: 'headline',
      verificationStatus: 'officially_confirmed',
      verificationConfidence: 0.9,
    });
  }
  return { journal, path };
}

/** A decision entry as it comes back off disk, for the pure helpers. */
function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-08-18T12:00:00.000Z',
    signalId: 'sig-1',
    expectedHorizon: '1-5d',
    eventId: 'evt-1',
    eventType: 'earnings',
    eventHeadline: 'headline',
    asset: 'AAPL',
    signal: 'BUY',
    modelConfidence: 0.8,
    score: 0.7,
    priceAtSignal: 100,
    verificationStatus: 'officially_confirmed',
    verificationConfidence: 0.9,
    sources: [],
    riskDecision: null,
    order: null,
    outcome: null,
    reasoning: { summary: '', catalyst: '', uncertainties: [], factors: [] },
    provenance: { provider: 'test', model: 'test', latencyMs: 1 },
    ...overrides,
  };
}

describe('when an outcome is due', () => {
  it('reads the horizon the thesis actually claimed', () => {
    // Reuses the exit manager's own label table, so a horizon never means one
    // thing to the stop and another to the scorecard.
    expect(outcomeDueAt(entry({ expectedHorizon: 'intraday' })).toISOString()).toBe(
      '2026-08-19T12:00:00.000Z',
    );
    expect(outcomeDueAt(entry({ expectedHorizon: '1-4w' })).toISOString()).toBe(
      '2026-09-15T12:00:00.000Z',
    );
  });

  it('gives an unstated horizon the default rather than an open-ended one', () => {
    expect(outcomeDueAt(entry({ expectedHorizon: undefined })).toISOString()).toBe(
      '2026-08-23T12:00:00.000Z',
    );
  });
});

describe('which decisions can be scored', () => {
  it('scores BUY and SELL, and leaves HOLD and WATCH alone', () => {
    // The scorer calls HOLD and WATCH non-directional and caps them. Marking
    // one "correct" would need a definition of right that nothing states.
    expect(isDirectional('BUY')).toBe(true);
    expect(isDirectional('SELL')).toBe(true);
    expect(isEvaluable(entry({ signal: 'HOLD' }))).toBe(false);
    expect(isEvaluable(entry({ signal: 'WATCH' }))).toBe(false);
  });

  it('skips a decision taken with no price to measure from', () => {
    expect(isEvaluable(entry({ priceAtSignal: null }))).toBe(false);
    expect(isEvaluable(entry({ priceAtSignal: 0 }))).toBe(false);
  });

  it('skips an entry written before outcomes existed rather than mismatching it', () => {
    expect(isEvaluable(entry({ signalId: undefined }))).toBe(false);
  });

  it('never scores the same decision twice', () => {
    const scored = entry({
      outcome: {
        evaluatedAt: '2026-08-23T12:00:00.000Z',
        priceAfter: 110,
        returnPct: 10,
        directionCorrect: true,
        horizonDays: 5,
      },
    });
    expect(isEvaluable(scored)).toBe(false);
  });
});

describe('scoring a decision', () => {
  it('calls a BUY right when the price rose and wrong when it fell', () => {
    const up = buildOutcome(entry(), 110, '2026-08-23T12:00:00.000Z');
    expect(up.returnPct).toBeCloseTo(10);
    expect(up.directionCorrect).toBe(true);

    const down = buildOutcome(entry(), 90, '2026-08-23T12:00:00.000Z');
    expect(down.returnPct).toBeCloseTo(-10);
    expect(down.directionCorrect).toBe(false);
  });

  it('calls a SELL right when the price fell', () => {
    const down = buildOutcome(entry({ signal: 'SELL' }), 90, '2026-08-23T12:00:00.000Z');
    expect(down.directionCorrect).toBe(true);
    const up = buildOutcome(entry({ signal: 'SELL' }), 110, '2026-08-23T12:00:00.000Z');
    expect(up.directionCorrect).toBe(false);
  });

  it('counts a flat move as wrong, for both directions', () => {
    // Predicting a direction and getting none is not a hit. Counting it as one
    // would inflate every hit rate the model is later shown.
    expect(buildOutcome(entry(), 100, 'x').directionCorrect).toBe(false);
    expect(buildOutcome(entry({ signal: 'SELL' }), 100, 'x').directionCorrect).toBe(false);
  });

  it('records the horizon it actually waited', () => {
    expect(buildOutcome(entry({ expectedHorizon: '1-4w' }), 110, 'x').horizonDays).toBe(28);
  });
});

describe('the journal as an append-only log', () => {
  it('lists nothing as pending before the horizon has elapsed', async () => {
    const { journal } = await journalWith([signal()]);
    // Recorded at 12:00 with a 5-day horizon: due 2026-08-23, not before.
    expect(await journal.pendingOutcomes(new Date('2026-08-22T12:00:00Z'))).toHaveLength(0);
    expect(await journal.pendingOutcomes(new Date('2026-08-23T12:00:00Z'))).toHaveLength(1);
  });

  it('folds a recorded outcome onto the decision it completes', async () => {
    const { journal } = await journalWith([signal()]);
    await journal.recordOutcome('sig-1', {
      evaluatedAt: '2026-08-23T12:00:00.000Z',
      priceAfter: 110,
      returnPct: 10,
      directionCorrect: true,
      horizonDays: 5,
    });

    const entries = await journal.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome?.returnPct).toBe(10);
    // ...and it is no longer pending.
    expect(await journal.pendingOutcomes(new Date('2026-09-01T00:00:00Z'))).toHaveLength(0);
  });

  it('appends the outcome instead of rewriting the decision', async () => {
    // The file's stated reason for being JSON Lines is that earlier entries
    // cannot be lost. Patching a line in place would trade that away.
    const { journal, path } = await journalWith([signal()]);
    const before = await readFile(path, 'utf8');

    await journal.recordOutcome('sig-1', {
      evaluatedAt: '2026-08-23T12:00:00.000Z',
      priceAfter: 110,
      returnPct: 10,
      directionCorrect: true,
      horizonDays: 5,
    });

    const after = await readFile(path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split('\n')).toHaveLength(2);
  });

  it('lets a re-evaluation supersede an earlier one', async () => {
    const { journal } = await journalWith([signal()]);
    const base = {
      evaluatedAt: '2026-08-23T12:00:00.000Z',
      directionCorrect: true,
      horizonDays: 5,
    };
    await journal.recordOutcome('sig-1', { ...base, priceAfter: 110, returnPct: 10 });
    await journal.recordOutcome('sig-1', { ...base, priceAfter: 120, returnPct: 20 });

    const entries = await journal.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome?.returnPct).toBe(20);
  });

  it('reports a real hit rate once outcomes exist', async () => {
    // The whole point: this number is handed to the model before every new
    // signal, and until now it was computed from an empty set.
    const { journal } = await journalWith([
      signal({ id: 'a' }),
      signal({ id: 'b' }),
      signal({ id: 'c' }),
    ]);
    const base = { evaluatedAt: 'x', priceAfter: 1, horizonDays: 5 };
    await journal.recordOutcome('a', { ...base, returnPct: 5, directionCorrect: true });
    await journal.recordOutcome('b', { ...base, returnPct: -5, directionCorrect: false });
    await journal.recordOutcome('c', { ...base, returnPct: 5, directionCorrect: true });

    const rates = await journal.hitRateByEventType();
    expect(rates.earnings).toEqual({ hitRate: 2 / 3, sampleSize: 3 });
  });

  it('ignores an outcome line that matches no decision', async () => {
    const { journal, path } = await journalWith([signal()]);
    await writeFile(
      path,
      `${await readFile(path, 'utf8')}${JSON.stringify({
        kind: 'outcome',
        signalId: 'nobody',
        outcome: { evaluatedAt: 'x', priceAfter: 1, returnPct: 1, directionCorrect: true, horizonDays: 5 },
      })}\n`,
      'utf8',
    );

    const entries = await journal.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBeNull();
  });
});

/**
 * End to end through the agent: the loop only closes if a later cycle actually
 * goes back and prices an earlier decision.
 */
describe('the agent scoring its own past decisions', () => {
  // Its own clock, not the module-level one the other suites share: this test
  // advances time, and a shared clock would carry that into its neighbours.
  const runClock = FixedClock.at('2026-08-16T12:00:00Z');

  beforeEach(() => {
    sourceRegistry.clear();
    sourceRegistry.registerAll([
      describeSource({ id: 'sec_edgar', name: 'SEC', tier: 'regulatory_filing', jurisdiction: 'US' }),
      describeSource({ id: 'outlet_a', name: 'A', tier: 'news', jurisdiction: 'US' }),
    ]);
  });

  function doc(
    source: string,
    title: string,
    content: string,
    metadata: Record<string, unknown> = {},
    tickers: string[] = [],
  ): NormalizedDocument {
    return normalizeDocument(
      {
        sourceId: source,
        externalId: `${source}:${title}`,
        title,
        content,
        publishedAt: '2026-08-16T10:00:00Z',
        retrievedAt: runClock.now().toISOString(),
        raw: {},
      },
      { clock: runClock, declaredTickers: tickers, metadata },
    );
  }

  function stackWith(documents: NormalizedDocument[]): IngestionStack {
    const source: DocumentSource = {
      id: 'fixture_docs',
      kind: 'news',
      sources: [],
      requiresCredentials: false,
      isConfigured: () => true,
      fetchDocuments: async () => documents,
      health: async () => ({
        adapter: 'fixture_docs',
        kind: 'news' as const,
        state: 'healthy' as const,
        checkedAt: runClock.now().toISOString(),
        requiresCredentials: false,
        credentialsPresent: true,
      }),
    };
    return {
      documentSources: [source],
      macroSources: [],
      marketData: new MarketDataService({
        providers: [new FixtureMarketDataAdapter({ clock: runClock, basePrices: { AAPL: 200 } })],
        maxStalenessSeconds: 120,
        clock: runClock,
      }),
      adapters: [source],
      deduplicator: new Deduplicator({ clock: runClock }),
    };
  }

  const llm: LLMProvider = {
    id: 'test',
    model: 'test-model',
    isConfigured: () => true,
    analyze: async <T,>() => ({
      value: {
        asset: 'AAPL',
        action: 'BUY',
        confidence: 0.85,
        expected_horizon: '1-5d',
        impact: 'positive',
        impact_strength: 0.8,
        reason: 'Results beat expectations.',
        catalyst: 'Q3 earnings above consensus',
        uncertainties: [],
        likely_priced_in: false,
        manipulation_suspected: false,
      } as T,
      usage: { inputTokens: 10, outputTokens: 10 },
      model: 'test-model',
      latencyMs: 3,
    }),
    health: async () => ({ state: 'healthy' as const }),
  };

  it('leaves a fresh decision unscored, then scores it once the horizon passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'journal-'));
    const journalPath = join(dir, 'decisions.jsonl');
    const agent = new TradingAgent({
      config: loadConfig({ WATCHLIST: 'AAPL', EVIDENCE_FILE: join(dir, 'no-evidence.json') }),
      clock: runClock,
      stack: stackWith([
        doc(
          'sec_edgar',
          'Apple Inc. filed 8-K — Results of Operations',
          'Form 8-K filed by Apple Inc. Reported items: 2.02.',
          { form: '8-K', items: ['2.02'] },
          ['AAPL'],
        ),
        doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, [
          'AAPL',
        ]),
      ]),
      llm,
      journalPath,
    });

    await agent.runCycle();
    const journal = new DecisionJournal({ path: journalPath, clock: runClock });

    // The decision exists, and nothing has been claimed about it: its horizon
    // has not passed, so an outcome now would be an invention.
    const afterFirst = await journal.readAll();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.outcome).toBeNull();
    expect(afterFirst[0]!.signalId).toBeDefined();
    expect(afterFirst[0]!.expectedHorizon).toBe('1-5d');
    expect(await journal.hitRateByEventType()).toEqual({});

    // Past the 5-day horizon, a later cycle goes back and prices it.
    runClock.advance(6 * 86_400_000);
    await agent.runCycle();

    const afterSecond = await journal.readAll();
    const scored = afterSecond.find((e) => e.signalId === afterFirst[0]!.signalId)!;
    expect(scored.outcome).not.toBeNull();
    expect(scored.outcome!.horizonDays).toBe(5);
    expect(Number.isFinite(scored.outcome!.returnPct)).toBe(true);
    expect(typeof scored.outcome!.directionCorrect).toBe('boolean');

    // And the number the model is shown before the next signal is now real.
    const rates = await journal.hitRateByEventType();
    expect(rates.earnings?.sampleSize).toBe(1);
  });
});
