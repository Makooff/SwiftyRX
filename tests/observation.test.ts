import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { IngestionStack } from '../src/ingestion/pipeline.js';
import type { DocumentSource } from '../src/ingestion/types.js';
import type { LLMProvider } from '../src/intelligence/llm/types.js';
import { EvidenceBook } from '../src/strategy/evidence.js';
import { observationVerdict } from '../src/strategy/observation.js';
import { evaluateAnalysisGate } from '../src/intelligence/pipeline.js';
import type { MarketEvent } from '../src/intelligence/types.js';

/**
 * Observation mode.
 *
 * The property that matters: a source being watched still costs an LLM call
 * and still fills the journal, because a decision that is never recorded can
 * never be scored — but it cannot move money until the study has measured it.
 * The gate is on the order, not on the analysis.
 */

function book(status: 'untested' | 'inconclusive' | 'supported'): EvidenceBook {
  return EvidenceBook.fromFile({
    generatedAt: '2026-08-19T00:00:00Z',
    windowYears: 5,
    roundTripCostPct: 0.3,
    symbols: 40,
    categories: [
      {
        category: '8-K item 2.02',
        eventType: 'earnings',
        status,
        sampleSize: status === 'untested' ? 4 : 500,
        clusters: status === 'untested' ? 2 : 30,
        note: '',
      },
    ],
  });
}

describe('deciding whether a watched source may trade', () => {
  const event = { sources: ['news_rss'], type: 'earnings' as const };

  it('changes nothing when no source is in observation', () => {
    // The default. An empty list must leave every existing source exactly as
    // it was, or this feature would silently alter a running system.
    expect(observationVerdict(event, new Set(), undefined).trades).toBe(true);
  });

  it('holds back an unmeasured event from a watched source', () => {
    const verdict = observationVerdict(event, new Set(['news_rss']), book('untested'));
    expect(verdict.trades).toBe(false);
    expect(verdict.trades === false && verdict.reason).toMatch(/earnings not yet measured/);
  });

  it('holds it back when no study has been run at all', () => {
    // No book means nothing is measured, which for a source explicitly placed
    // in observation means it stays there. That is the point of listing it.
    expect(observationVerdict(event, new Set(['news_rss']), undefined).trades).toBe(false);
  });

  it('promotes it as soon as the category is measured, without an edit', () => {
    expect(observationVerdict(event, new Set(['news_rss']), book('inconclusive')).trades).toBe(true);
    expect(observationVerdict(event, new Set(['news_rss']), book('supported')).trades).toBe(true);
  });

  it('lets an event through when an established source corroborates it', () => {
    // One source outside the list is enough: the event would have existed on
    // that source's own footing, which is the same reasoning that lets a
    // filing carry an event a social post also mentions.
    const corroborated = { sources: ['news_rss', 'sec_edgar'], type: 'earnings' as const };
    expect(observationVerdict(corroborated, new Set(['news_rss']), book('untested')).trades).toBe(true);
  });

  it('leaves a source outside the list alone', () => {
    const other = { sources: ['sec_edgar'], type: 'earnings' as const };
    expect(observationVerdict(other, new Set(['news_rss']), book('untested')).trades).toBe(true);
  });
});

describe('an agent watching a source end to end', () => {
  const runClock = FixedClock.at('2026-08-19T12:00:00Z');

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
        publishedAt: '2026-08-19T10:00:00Z',
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

  /** Documents that on their own produce a tradeable earnings event. */
  const earnings = () => [
    doc(
      'sec_edgar',
      'Apple Inc. filed 8-K — Results of Operations',
      'Form 8-K filed by Apple Inc. Reported items: 2.02.',
      { form: '8-K', items: ['2.02'] },
      ['AAPL'],
    ),
    doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
  ];

  async function agentWith(observationSources: string) {
    const dir = await mkdtemp(join(tmpdir(), 'observation-'));
    const journalPath = join(dir, 'decisions.jsonl');
    const agent = new TradingAgent({
      config: loadConfig({
        WATCHLIST: 'AAPL',
        EVIDENCE_FILE: join(dir, 'no-evidence.json'),
        CORRELATION_FILE: join(dir, 'no-correlations.json'),
        ...(observationSources ? { OBSERVATION_ONLY_SOURCES: observationSources } : {}),
      }),
      clock: runClock,
      stack: stackWith(earnings()),
      llm,
      journalPath,
    });
    return { agent, journalPath };
  }

  it('trades normally when nothing is in observation', async () => {
    const { agent } = await agentWith('');
    await agent.runCycle();
    expect(agent.getState().ordersPlaced).toBe(1);
  });

  it('still analyses and journals a watched event, but places no order', async () => {
    // Both of this event's sources are watched, so it is held back — and the
    // decision is recorded anyway, which is the entire reason for paying the
    // LLM call rather than stopping earlier.
    const { agent, journalPath } = await agentWith('sec_edgar,outlet_a');
    await agent.runCycle();

    expect(agent.getState().signalsGenerated).toBe(1);
    expect(agent.getState().ordersPlaced).toBe(0);
    expect(agent.portfolio.openPositions).toHaveLength(0);

    const entries = (await readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0]!);
    expect(entry.signal).toBe('BUY');
    expect(entry.order).toBeNull();
    // Recorded with a signal id, so outcome tracking can score it later —
    // which is how a watched source eventually earns its promotion.
    expect(entry.signalId).toBeDefined();
  });

  it('names the observation gate in the funnel rather than blaming the price', async () => {
    const { agent } = await agentWith('sec_edgar,outlet_a');
    await agent.runCycle();

    const risk = agent.getFunnels()[0]!.steps.find((step) => step.stage === 'risk')!;
    expect(risk.count).toBe(0);
    expect(risk.reasons).toMatchObject({ 'observation only': 1 });
    expect(risk.reasons?.['not tradeable or halted']).toBeUndefined();
  });

  it('says on the activity feed why the order was not placed', async () => {
    const { agent } = await agentWith('sec_edgar,outlet_a');
    await agent.runCycle();

    const feed = agent.activity.recent().map((entry) => entry.message).join(' | ');
    expect(feed).toMatch(/not placed — observation only/);
  });

  it('trades when only one of the event’s sources is watched', async () => {
    // sec_edgar is established here, so the event stands on it.
    const { agent } = await agentWith('outlet_a');
    await agent.runCycle();
    expect(agent.getState().ordersPlaced).toBe(1);
  });
});

describe('letting a watched source reach the analysis it is watched for', () => {
  /**
   * The defect this closes: observation was gated at the Risk Engine, which is
   * two steps after the analysis gate. A social-only event is capped at 0.35
   * confidence by the verifier and the floor is 0.50, so a watched X account
   * was dropped before any LLM call — never analysed, never journalled, never
   * scored, and therefore unable to earn the automatic promotion the feature
   * promises. Observation of exactly the sources most worth observing did
   * nothing at all.
   */

  const WATCHED = new Set(['x:@influencer']);

  function socialEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
    return {
      id: 'e1',
      type: 'other',
      headline: 'A coin is going to the moon',
      summary: '',
      firstSeenAt: '2026-08-19T11:00:00Z',
      lastUpdatedAt: '2026-08-19T11:00:00Z',
      entities: [],
      tickers: ['DOGE/USD'],
      jurisdictions: [],
      documentIds: ['d1'],
      sources: ['x:@influencer'],
      links: [],
      classification: { type: 'other', confidence: 0.5, matchedRules: [] },
      materiality: 0.6,
      verification: {
        status: 'unverified',
        confidence: 0.2,
        distinctSources: 1,
        independentReports: 1,
        authoritativeSources: [],
        contradictions: [],
        reasons: [],
      },
      ...overrides,
    } as MarketEvent;
  }

  it('drops a low-confidence event when nothing is being watched', () => {
    // The unchanged default, and the behaviour every existing setup keeps.
    const result = evaluateAnalysisGate([socialEvent()]);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedByReason).toMatchObject({ 'confidence below 0.5': 1 });
  });

  it('analyses it when its source is under observation', () => {
    const result = evaluateAnalysisGate([socialEvent()], {
      observationSources: WATCHED,
      observationBudget: 3,
    });
    expect(result.kept).toHaveLength(1);
  });

  it('spends a bounded budget and says so when it runs out', () => {
    // Every one of these is a paid LLM call on information nobody has shown to
    // be worth anything. A switch would be an unbounded bill.
    const events = [socialEvent({ id: 'a' }), socialEvent({ id: 'b' }), socialEvent({ id: 'c' })];
    const result = evaluateAnalysisGate(events, {
      observationSources: WATCHED,
      observationBudget: 2,
    });
    expect(result.kept).toHaveLength(2);
    expect(result.droppedByReason).toMatchObject({ 'observation budget spent this cycle': 1 });
  });

  it('does nothing for a source outside the list', () => {
    const other = socialEvent({ sources: ['x:@someone_else'] });
    const result = evaluateAnalysisGate([other], {
      observationSources: WATCHED,
      observationBudget: 3,
    });
    expect(result.kept).toHaveLength(0);
  });

  it('still refuses a contradicted event, watched or not', () => {
    // Watching a source is not a reason to spend a call interpreting something
    // we have positive evidence is false.
    const contradicted = socialEvent({
      verification: { ...socialEvent().verification, status: 'contradicted' },
    });
    const result = evaluateAnalysisGate([contradicted], {
      observationSources: WATCHED,
      observationBudget: 3,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.droppedByReason).toMatchObject({ contradicted: 1 });
  });

  it('still refuses an unclassified event, watched or not', () => {
    // Unclassified is not a judgement about the source at all.
    const result = evaluateAnalysisGate([socialEvent({ type: 'unclassified' })], {
      observationSources: WATCHED,
      observationBudget: 3,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.droppedByReason).toMatchObject({ unclassified: 1 });
  });

  it('still refuses an immaterial event, watched or not', () => {
    const result = evaluateAnalysisGate([socialEvent({ materiality: 0.1 })], {
      observationSources: WATCHED,
      observationBudget: 3,
    });
    expect(result.kept).toHaveLength(0);
  });

  it('does not spend budget on an event that would have passed anyway', () => {
    // A corroborated event clears the floor on its own; charging it to the
    // observation budget would starve the ones that actually need it.
    const confident = socialEvent({
      verification: { ...socialEvent().verification, confidence: 0.8 },
    });
    const result = evaluateAnalysisGate([confident, socialEvent({ id: 'b' })], {
      observationSources: WATCHED,
      observationBudget: 1,
    });
    expect(result.kept).toHaveLength(2);
  });
});
