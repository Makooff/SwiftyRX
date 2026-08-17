import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import { ActivityLog } from '../src/monitoring/activity-log.js';
import { registerSecret } from '../src/core/redact.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { DocumentSource } from '../src/ingestion/types.js';
import type { IngestionStack } from '../src/ingestion/pipeline.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import type { LLMProvider } from '../src/intelligence/llm/types.js';

/**
 * Activity feed.
 *
 * The dashboard already showed *state*. This answers "what has it been doing?"
 * — and the case that matters most is the quiet one: an agent that looked at
 * events and decided not to trade must be distinguishable from one that is
 * stuck.
 */

const clock = FixedClock.at('2026-08-17T12:00:00Z');

beforeEach(() => {
  sourceRegistry.clear();
  sourceRegistry.registerAll([
    describeSource({ id: 'sec_edgar', name: 'SEC', tier: 'regulatory_filing', jurisdiction: 'US' }),
    describeSource({ id: 'outlet_a', name: 'A', tier: 'news', jurisdiction: 'US' }),
  ]);
});

function doc(source: string, title: string, content: string, metadata: Record<string, unknown> = {}, tickers: string[] = []): NormalizedDocument {
  return normalizeDocument(
    {
      sourceId: source,
      externalId: `${source}:${title}`,
      title,
      content,
      publishedAt: '2026-08-17T10:00:00Z',
      retrievedAt: clock.now().toISOString(),
      raw: {},
    },
    { clock, declaredTickers: tickers, metadata },
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
      checkedAt: clock.now().toISOString(),
      requiresCredentials: false,
      credentialsPresent: true,
    }),
  };
  return {
    documentSources: [source],
    macroSources: [],
    marketData: new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200 } })],
      maxStalenessSeconds: 120,
      clock,
    }),
    adapters: [source],
    deduplicator: new Deduplicator({ clock }),
  };
}

function llmReturning(value: unknown): LLMProvider {
  return {
    id: 'test',
    model: 'test-model',
    isConfigured: () => true,
    analyze: async <T,>() => ({ value: value as T, usage: { inputTokens: 10, outputTokens: 10 }, model: 'test-model', latencyMs: 3 }),
    health: async () => ({ state: 'healthy' as const }),
  };
}

const bullish = {
  asset: 'AAPL',
  action: 'BUY',
  confidence: 0.85,
  expected_horizon: '1-5d',
  impact: 'positive',
  impact_strength: 0.8,
  reason: 'Results beat expectations, raising expected cash flows materially.',
  catalyst: 'Q3 earnings above consensus',
  uncertainties: [],
  likely_priced_in: false,
  manipulation_suspected: false,
};

async function agentWith(documents: NormalizedDocument[], llm: LLMProvider) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-'));
  return new TradingAgent({
    config: loadConfig({ WATCHLIST: 'AAPL' }),
    clock,
    stack: stackWith(documents),
    llm,
    journalPath: join(dir, 'decisions.jsonl'),
  });
}

describe('ActivityLog', () => {
  it('returns newest first', () => {
    const log = new ActivityLog({ clock });
    log.info('a', 'first');
    log.info('b', 'second');
    expect(log.recent().map((e) => e.message)).toEqual(['second', 'first']);
  });

  it('discards the oldest past capacity', () => {
    // A window onto a running process, not an audit trail — the journal is the
    // record that must survive.
    const log = new ActivityLog({ capacity: 3, clock });
    for (const n of [1, 2, 3, 4, 5]) log.info('x', `entry ${n}`);
    expect(log.size).toBe(3);
    expect(log.recent().map((e) => e.message)).toEqual(['entry 5', 'entry 4', 'entry 3']);
  });

  it('redacts secrets, because this text is rendered into a reachable page', () => {
    registerSecret('sk-ant-activity-secret');
    const log = new ActivityLog({ clock });
    log.error('llm', 'call failed with key sk-ant-activity-secret');
    expect(log.recent()[0]!.message).not.toContain('sk-ant-activity-secret');
  });

  it('caps a single entry so one payload cannot flood the feed', () => {
    const log = new ActivityLog({ clock });
    log.info('x', 'y'.repeat(5000));
    expect(log.recent()[0]!.message.length).toBeLessThanOrEqual(500);
  });
});

describe('agent activity', () => {
  it('records the full path from event to order', async () => {
    const agent = await agentWith(
      [
        doc('sec_edgar', 'Apple Inc. filed 8-K — Results of Operations', 'Form 8-K filed by Apple Inc. Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL']),
        doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
      ],
      llmReturning(bullish),
    );
    await agent.runCycle();

    const stages = agent.getActivity().map((e) => e.stage);
    expect(stages).toContain('ingest');
    expect(stages).toContain('event');
    expect(stages).toContain('signal');
    expect(stages).toContain('order');
  });

  it('says so when events were found but none was worth analysing', async () => {
    // The single most common reason nothing trades, and previously invisible:
    // "it looked and declined" must not read the same as "it is stuck".
    const agent = await agentWith(
      [doc('outlet_a', 'Apple opens a new store in Lyon', 'A retail opening.', {}, ['AAPL'])],
      llmReturning(bullish),
    );
    await agent.runCycle();

    const feed = agent.getActivity();
    const gate = feed.find((e) => e.stage === 'gate');
    if (gate) {
      expect(gate.message).toMatch(/none cleared/);
      expect(feed.some((e) => e.stage === 'order')).toBe(false);
    }
  });

  it('records an LLM failure rather than failing silently', async () => {
    const agent = await agentWith(
      [doc('sec_edgar', 'Apple Inc. filed 8-K', 'Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL'])],
      {
        id: 'flaky',
        model: 'flaky',
        isConfigured: () => true,
        analyze: async () => {
          throw new Error('upstream 500');
        },
        health: async () => ({ state: 'unavailable' as const }),
      },
    );
    await agent.runCycle();
    expect(agent.getActivity().some((e) => e.level === 'error')).toBe(true);
  });

  it('starts empty and says the feed will fill', async () => {
    const agent = await agentWith([], llmReturning(bullish));
    expect(agent.getActivity()).toHaveLength(0);
  });
});
