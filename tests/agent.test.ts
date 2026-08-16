import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { createApiServer } from '../apps/api/server.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
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
 * End-to-end tests for the trading agent.
 *
 * The whole pipeline runs against fixtures: documents in, decisions out, with
 * no network and no real broker. The properties under test are the ones that
 * matter for safety, not for profit.
 */

const clock = FixedClock.at('2026-08-16T12:00:00Z');

beforeEach(() => {
  sourceRegistry.clear();
  sourceRegistry.registerAll([
    describeSource({ id: 'sec_edgar', name: 'SEC', tier: 'regulatory_filing', jurisdiction: 'US' }),
    describeSource({ id: 'outlet_a', name: 'A', tier: 'news', jurisdiction: 'US' }),
    describeSource({ id: 'x:@rumour', name: 'X', tier: 'social', reliability: 0.2 }),
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

/** A document source that returns a fixed list. */
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
  const marketData = new MarketDataService({
    providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200, NVDA: 120 } })],
    maxStalenessSeconds: 120,
    clock,
  });
  return {
    documentSources: [fixedSource(documents)],
    macroSources: [],
    marketData,
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

const bullishHypothesis = {
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

async function agentWith(documents: NormalizedDocument[], llm: LLMProvider, overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-'));
  const journalPath = join(dir, 'decisions.jsonl');
  const agent = new TradingAgent({
    config: loadConfig({ WATCHLIST: 'AAPL', ...overrides }),
    clock,
    stack: stackWith(documents),
    llm,
    journalPath,
  });
  return { agent, journalPath };
}

describe('TradingAgent — end to end', () => {
  it('runs a full cycle from documents to a filled paper order', async () => {
    const documents = [
      doc(
        'sec_edgar',
        'Apple Inc. filed 8-K — Results of Operations',
        'Form 8-K filed by Apple Inc. Reported items: 2.02.',
        { form: '8-K', items: ['2.02'] },
        ['AAPL'],
      ),
      doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
    ];

    const { agent, journalPath } = await agentWith(documents, llmReturning(bullishHypothesis));
    await agent.runCycle();

    const state = agent.getState();
    expect(state.eventsDetected).toBeGreaterThan(0);
    expect(state.signalsGenerated).toBeGreaterThan(0);
    expect(state.ordersPlaced).toBe(1);
    expect(agent.portfolio.openPositions).toHaveLength(1);

    // Every decision is journalled, including its reasoning and factors.
    const journal = await readFile(journalPath, 'utf8');
    const entry = JSON.parse(journal.trim().split('\n')[0]!);
    expect(entry.asset).toBe('AAPL');
    expect(entry.order.status).toBe('filled');
    expect(entry.reasoning.factors.length).toBeGreaterThan(3);
  });

  it('journals a decision even when no order results', async () => {
    // A journal of only executed trades is survivorship-biased and cannot
    // answer whether the signals work.
    const documents = [
      doc('outlet_a', 'Apple to acquire a robotics startup', 'Sources say a deal is close.', {}, ['AAPL']),
    ];
    const { agent, journalPath } = await agentWith(
      documents,
      llmReturning({ ...bullishHypothesis, confidence: 0.3, impact_strength: 0.2 }),
    );
    await agent.runCycle();

    const entries = (await readFile(journalPath, 'utf8')).trim().split('\n').filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it('never trades on a social-only rumour, however confident the model is', async () => {
    const documents = [
      doc('x:@rumour', 'BREAKING: Apple to announce a massive acquisition today', 'Huge news coming. $AAPL', {}, ['AAPL']),
    ];
    const { agent } = await agentWith(documents, llmReturning({ ...bullishHypothesis, confidence: 1 }));
    await agent.runCycle();

    expect(agent.getState().ordersPlaced).toBe(0);
    expect(agent.portfolio.openPositions).toHaveLength(0);
  });

  it('does not trade a contradicted event', async () => {
    const documents = [
      doc('outlet_a', 'Apple to acquire a robotics startup', 'A deal is close, sources say.', {}, ['AAPL']),
      doc('outlet_a', 'Apple denies the acquisition report', 'The company said the report is without merit.', {}, ['AAPL']),
    ];
    const { agent } = await agentWith(documents, llmReturning(bullishHypothesis));
    await agent.runCycle();
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it('generates no signals when no LLM is configured', async () => {
    const documents = [
      doc('sec_edgar', 'Apple Inc. filed 8-K', 'Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL']),
    ];
    const { agent } = await agentWith(documents, {
      id: 'none',
      model: 'none',
      isConfigured: () => false,
      analyze: async () => {
        throw new Error('should not be called');
      },
      health: async () => ({ state: 'disabled' as const }),
    });

    await agent.runCycle();
    expect(agent.getState().eventsDetected).toBeGreaterThan(0);
    expect(agent.getState().signalsGenerated).toBe(0);
  });

  it('survives an LLM failure without crashing the cycle', async () => {
    const documents = [
      doc('sec_edgar', 'Apple Inc. filed 8-K', 'Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL']),
    ];
    const { agent } = await agentWith(documents, {
      id: 'flaky',
      model: 'flaky',
      isConfigured: () => true,
      analyze: async () => {
        throw new Error('upstream 500');
      },
      health: async () => ({ state: 'unavailable' as const }),
    });

    await expect(agent.runCycle()).resolves.toBeUndefined();
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it('halts trading after the daily loss limit and says why', async () => {
    const documents = [
      doc('sec_edgar', 'Apple Inc. filed 8-K', 'Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['AAPL']),
    ];
    const { agent } = await agentWith(documents, llmReturning(bullishHypothesis));

    // A realised loss, not just a mark: marks are refreshed from live data at
    // the start of every cycle, so an unrealised paper loss would be erased.
    agent.portfolio.applyBuy('AAPL', 20, 200, 1);
    agent.portfolio.applySell('AAPL', 20, 100, 1);

    await agent.runCycle();
    expect(agent.getState().halted).toBe(true);
    expect(agent.getState().haltReasons.join(' ')).toMatch(/daily loss/);
  });

  it('starts with the paper capital, not the live target', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    expect(agent.portfolio.initialCash).toBe(10_000);
  });
});

describe('dashboard API', () => {
  it('serves HTML that shows the mode and never leaks a key', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-secret-value-12345' });
    const server = createApiServer({ agent, config });

    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve({ status: res.status, body: await res.text() });
        server.close();
      });
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('AI Market Agent');
    expect(response.body).toContain('NO REAL MONEY');
    expect(response.body).not.toContain('sk-ant-secret-value-12345');
  });

  it('exposes no endpoint that can place or cancel an order', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const server = createApiServer({ agent, config: loadConfig({}) });

    const results = await new Promise<number[]>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const codes: number[] = [];
        for (const path of ['/api/order', '/api/orders/place', '/api/trade', '/api/cancel']) {
          codes.push((await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST' })).status);
        }
        resolve(codes);
        server.close();
      });
    });

    // The dashboard observes; it does not act.
    expect(results.every((code) => code === 404)).toBe(true);
  });
});
