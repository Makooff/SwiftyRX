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
