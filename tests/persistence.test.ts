import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import {
  AgentStateStore,
  fingerprintOf,
  StateMismatchError,
} from '../src/database/agent-state-store.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { DocumentSource } from '../src/ingestion/types.js';
import type { IngestionStack } from '../src/ingestion/pipeline.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import type { LLMProvider } from '../src/intelligence/llm/types.js';
import { Portfolio } from '../src/execution/paper/portfolio.js';

/**
 * State persistence.
 *
 * The property under test is not "the file round-trips" but "a restarted agent
 * is the same experiment". A paper run that silently restarts from its opening
 * balance produces a track record that is a fiction, and the whole project is
 * an argument about whether the track record means anything.
 */

const clock = FixedClock.at('2026-08-16T12:00:00Z');

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
      publishedAt: '2026-08-16T10:00:00Z',
      retrievedAt: clock.now().toISOString(),
      raw: {},
    },
    { clock, declaredTickers: tickers, metadata },
  );
}

function fixedSource(documents: NormalizedDocument[]): DocumentSource {
  return {
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
}

function stackWith(documents: NormalizedDocument[]): IngestionStack {
  return {
    documentSources: [fixedSource(documents)],
    macroSources: [],
    marketData: new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200 } })],
      maxStalenessSeconds: 120,
      clock,
    }),
    adapters: [fixedSource(documents)],
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

/**
 * Built per test, not once at module load: `normalizeDocument` stamps the
 * source's reliability at construction, and the registry is cleared in
 * `beforeEach`. A module-level constant would carry the unknown-source prior
 * and never clear the analysis gate.
 */
function earningsDocs(): NormalizedDocument[] {
  return [
    doc('sec_edgar', 'Apple Inc. filed 8-K — Results of Operations', 'Form 8-K filed by Apple Inc. Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL']),
    doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
  ];
}

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'state-'));
  return join(dir, name);
}

// ---------------------------------------------------------------------------
// Portfolio round trip
// ---------------------------------------------------------------------------

describe('portfolio serialisation', () => {
  it('restores cash, positions, trades and drawdown history', () => {
    const original = new Portfolio({ initialCash: 10_000, clock });
    original.applyBuy('AAPL', 10, 200, 1);
    original.mark('AAPL', 150);
    original.applySell('AAPL', 5, 150, 1);

    const restored = Portfolio.restore(original.serialize(), { clock });

    expect(restored.availableCash).toBe(original.availableCash);
    expect(restored.totalValue).toBe(original.totalValue);
    expect(restored.openPositions).toEqual(original.openPositions);
    expect(restored.trades).toEqual(original.trades);
    // Peak and max drawdown are the numbers a flattering restart would quietly
    // reset. They must survive.
    expect(restored.maxDrawdown).toBe(original.maxDrawdown);
    expect(restored.drawdownPct).toBe(original.drawdownPct);
  });

  it('keeps the risk engine counters that gate further trading', () => {
    const original = new Portfolio({ initialCash: 10_000, clock });
    original.applyBuy('AAPL', 10, 200, 1);
    original.applySell('AAPL', 10, 100, 1);

    const restored = Portfolio.restore(original.serialize(), { clock });
    const before = original.snapshot();
    const after = restored.snapshot();

    expect(after.consecutiveLosses).toBe(before.consecutiveLosses);
    expect(after.realisedPnlToday).toBe(before.realisedPnlToday);
    expect(after.tradesToday).toBe(before.tradesToday);
    expect(after.dayStartValue).toBe(before.dayStartValue);
  });

  it('restores the original starting capital, not the configured one', () => {
    // Restoring a 10k run into a portfolio that thinks it began at 300 would
    // report a return of several thousand percent on the first cycle.
    const original = new Portfolio({ initialCash: 10_000, clock });
    const restored = Portfolio.restore(original.serialize(), { clock });
    expect(restored.initialCash).toBe(10_000);
    expect(restored.totalReturnPct).toBe(0);
  });

  it('refuses a state version it does not understand', () => {
    const state = { ...new Portfolio({ initialCash: 100, clock }).serialize(), version: 2 as unknown as 1 };
    expect(() => Portfolio.restore(state, { clock })).toThrow(/version/i);
  });
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('agent state store', () => {
  const config = loadConfig({ WATCHLIST: 'AAPL' });

  it('returns undefined when there is no state yet', async () => {
    const store = new AgentStateStore({ path: await tempPath('none.json'), clock });
    expect(store.load(fingerprintOf(config))).toBeUndefined();
  });

  it('round-trips through the file system', async () => {
    const store = new AgentStateStore({ path: await tempPath('state.json'), clock });
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    portfolio.applyBuy('AAPL', 5, 200, 1);

    store.save({
      fingerprint: fingerprintOf(config),
      portfolio: portfolio.serialize(),
      counters: { cycles: 3, documentsIngested: 12, eventsDetected: 2, signalsGenerated: 1, ordersPlaced: 1, ordersRejectedByRisk: 0 },
      consumedOrderIds: ['order-1'],
      firstStartedAt: '2026-08-01T00:00:00.000Z',
    });

    const loaded = store.load(fingerprintOf(config));
    expect(loaded?.counters.cycles).toBe(3);
    expect(loaded?.consumedOrderIds).toEqual(['order-1']);
    expect(loaded?.firstStartedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(loaded?.portfolio.positions).toHaveLength(1);
  });

  it('refuses a state saved under different capital rather than reconciling it', async () => {
    const store = new AgentStateStore({ path: await tempPath('state.json'), clock });
    store.save({
      fingerprint: { mode: 'paper', currency: 'EUR', initialCapital: 50_000 },
      portfolio: new Portfolio({ initialCash: 50_000, clock }).serialize(),
      counters: { cycles: 1, documentsIngested: 0, eventsDetected: 0, signalsGenerated: 0, ordersPlaced: 0, ordersRejectedByRisk: 0 },
      consumedOrderIds: [],
      firstStartedAt: clock.now().toISOString(),
    });

    expect(() => store.load(fingerprintOf(config))).toThrow(StateMismatchError);
  });

  it('refuses a state saved in a different mode', async () => {
    const store = new AgentStateStore({ path: await tempPath('state.json'), clock });
    store.save({
      fingerprint: { mode: 'backtest', currency: 'EUR', initialCapital: config.initialCapital },
      portfolio: new Portfolio({ initialCash: config.initialCapital, clock }).serialize(),
      counters: { cycles: 1, documentsIngested: 0, eventsDetected: 0, signalsGenerated: 0, ordersPlaced: 0, ordersRejectedByRisk: 0 },
      consumedOrderIds: [],
      firstStartedAt: clock.now().toISOString(),
    });

    expect(() => store.load(fingerprintOf(config))).toThrow(StateMismatchError);
  });

  it('fails loudly on a corrupt file instead of starting fresh', async () => {
    const path = await tempPath('state.json');
    await writeFile(path, '{ not json', 'utf8');
    const store = new AgentStateStore({ path, clock });
    expect(() => store.load(fingerprintOf(config))).toThrow(/not valid JSON/);
  });

  it('leaves no partial file behind: the target is only ever a complete state', async () => {
    const store = new AgentStateStore({ path: await tempPath('state.json'), clock });
    const save = () =>
      store.save({
        fingerprint: fingerprintOf(config),
        portfolio: new Portfolio({ initialCash: config.initialCapital, clock }).serialize(),
        counters: { cycles: 1, documentsIngested: 0, eventsDetected: 0, signalsGenerated: 0, ordersPlaced: 0, ordersRejectedByRisk: 0 },
        consumedOrderIds: [],
        firstStartedAt: clock.now().toISOString(),
      });

    save();
    save();

    const raw = await readFile(store.path, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The agent across a restart
// ---------------------------------------------------------------------------

describe('TradingAgent across a restart', () => {
  async function agentWith(documents: NormalizedDocument[], statePath: string) {
    const dir = await mkdtemp(join(tmpdir(), 'journal-'));
    return new TradingAgent({
      config: loadConfig({ WATCHLIST: 'AAPL' }),
      clock,
      stack: stackWith(documents),
      llm: llmReturning(bullish),
      journalPath: join(dir, 'decisions.jsonl'),
      stateStore: new AgentStateStore({ path: statePath, clock }),
    });
  }

  it('resumes the portfolio and counters instead of starting over', async () => {
    const statePath = await tempPath('agent.json');

    const first = await agentWith(earningsDocs(), statePath);
    await first.runCycle();
    expect(first.getState().ordersPlaced).toBe(1);
    const valueBefore = first.portfolio.totalValue;
    const cyclesBefore = first.getState().cycles;

    const second = await agentWith([], statePath);
    expect(second.portfolio.openPositions).toHaveLength(1);
    expect(second.portfolio.totalValue).toBe(valueBefore);
    expect(second.getState().cycles).toBe(cyclesBefore);
    expect(second.getState().ordersPlaced).toBe(1);
  });

  it('does not re-place an order it already placed before the restart', async () => {
    const statePath = await tempPath('agent.json');

    const first = await agentWith(earningsDocs(), statePath);
    await first.runCycle();
    expect(first.getState().ordersPlaced).toBe(1);

    // Same documents, same event, same derived order id: a restart must not
    // turn a replayed signal into a second position.
    const second = await agentWith(earningsDocs(), statePath);
    await second.runCycle();
    expect(second.getState().ordersPlaced).toBe(1);
    expect(second.portfolio.openPositions).toHaveLength(1);
  });

  it('checkpoints even on a cycle that produces nothing', async () => {
    const statePath = await tempPath('agent.json');
    const agent = await agentWith([], statePath);
    await agent.runCycle();

    const store = new AgentStateStore({ path: statePath, clock });
    expect(store.load(fingerprintOf(loadConfig({ WATCHLIST: 'AAPL' })))?.counters.cycles).toBe(1);
  });

  it('starts fresh when no store is supplied', async () => {
    const statePath = await tempPath('agent.json');
    const first = await agentWith(earningsDocs(), statePath);
    await first.runCycle();

    const dir = await mkdtemp(join(tmpdir(), 'journal-'));
    const stateless = new TradingAgent({
      config: loadConfig({ WATCHLIST: 'AAPL' }),
      clock,
      stack: stackWith([]),
      llm: llmReturning(bullish),
      journalPath: join(dir, 'decisions.jsonl'),
    });

    expect(stateless.getState().cycles).toBe(0);
    expect(stateless.portfolio.openPositions).toHaveLength(0);
  });

  it('refuses to resume a run saved under different capital', async () => {
    const statePath = await tempPath('agent.json');
    const first = await agentWith(earningsDocs(), statePath);
    await first.runCycle();

    expect(
      () =>
        new TradingAgent({
          config: loadConfig({ WATCHLIST: 'AAPL', PAPER_CAPITAL_EUR: '50000' }),
          clock,
          stack: stackWith([]),
          llm: llmReturning(bullish),
          stateStore: new AgentStateStore({ path: statePath, clock }),
        }),
    ).toThrow(StateMismatchError);
  });
});
