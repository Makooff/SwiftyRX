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
import type { EventType } from '../src/intelligence/types.js';
import { EvidenceBook } from '../src/strategy/evidence.js';

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

/** Like llmReturning, but the provider publishes a price for every call. */
function llmCosting(value: unknown, costUsd: number): LLMProvider {
  return {
    id: 'test',
    model: 'test-model',
    isConfigured: () => true,
    analyze: async <T,>() => ({
      value: value as T,
      usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: costUsd },
      model: 'test-model',
      latencyMs: 3,
    }),
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

async function agentWith(
  documents: NormalizedDocument[],
  llm: LLMProvider,
  overrides: Record<string, string> = {},
  evidence?: EvidenceBook,
) {
  const dir = await mkdtemp(join(tmpdir(), 'journal-'));
  const journalPath = join(dir, 'decisions.jsonl');
  const agent = new TradingAgent({
    config: loadConfig({
      WATCHLIST: 'AAPL',
      // Hermetic: a study run on the developer's own machine writes a real
      // evidence book, and these tests must not silently start reading it.
      EVIDENCE_FILE: join(dir, 'no-evidence.json'),
      ...overrides,
    }),
    clock,
    stack: stackWith(documents),
    llm,
    journalPath,
    ...(evidence ? { evidence } : {}),
  });
  return { agent, journalPath };
}

/** A book that refuses one event type and says nothing about anything else. */
function bookBlocking(eventType: EventType, category: string): EvidenceBook {
  return EvidenceBook.fromFile({
    generatedAt: '2026-08-17T00:00:00Z',
    windowYears: 5,
    benchmark: 'SPY',
    roundTripCostPct: 0.3,
    symbols: 40,
    categories: [
      {
        category,
        eventType,
        status: 'adverse',
        sampleSize: 109,
        clusters: 31,
        horizon: { sessions: 20, meanAbnormalPct: -1.64, meanNetOfCostsPct: -1.94, tStat: -2.4 },
        note: 'moves against a long',
      },
    ],
  });
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

describe('the evidence gate', () => {
  const earningsFiling = () => [
    doc(
      'sec_edgar',
      'Apple Inc. filed 8-K — Results of Operations',
      'Form 8-K filed by Apple Inc. Reported items: 2.02.',
      { form: '8-K', items: ['2.02'] },
      ['AAPL'],
    ),
    doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
  ];

  it('trades the event when no study has been run', async () => {
    // The baseline the gate is measured against: without a book, nothing
    // changes.
    const { agent } = await agentWith(earningsFiling(), llmReturning(bullishHypothesis));
    await agent.runCycle();
    expect(agent.getState().ordersPlaced).toBe(1);
  });

  it('refuses the same event once the study measured it drifting against a long', async () => {
    const { agent } = await agentWith(
      earningsFiling(),
      llmReturning(bullishHypothesis),
      {},
      bookBlocking('earnings', '8-K item 2.02'),
    );
    await agent.runCycle();

    expect(agent.getState().ordersPlaced).toBe(0);
    expect(agent.portfolio.openPositions).toHaveLength(0);
  });

  it('spends no LLM call on a blocked event', async () => {
    // The gate sits before analysis on purpose: paying a model to interpret an
    // entry already measured as losing is the most expensive route to the same
    // answer.
    let calls = 0;
    const counting: LLMProvider = {
      id: 'counting',
      model: 'counting',
      isConfigured: () => true,
      analyze: async <T,>() => {
        calls += 1;
        return {
          value: bullishHypothesis as T,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'counting',
          latencyMs: 1,
        };
      },
      health: async () => ({ state: 'healthy' as const }),
    };

    const { agent } = await agentWith(
      earningsFiling(),
      counting,
      {},
      bookBlocking('earnings', '8-K item 2.02'),
    );
    await agent.runCycle();
    expect(calls).toBe(0);
  });

  it('says on the activity feed why it stood down', async () => {
    // A silent refusal is indistinguishable from a broken pipeline, which is
    // exactly the confusion this agent has already caused once.
    const { agent } = await agentWith(
      earningsFiling(),
      llmReturning(bullishHypothesis),
      {},
      bookBlocking('earnings', '8-K item 2.02'),
    );
    await agent.runCycle();

    const feed = agent.activity.recent().map((entry) => entry.message).join(' | ');
    expect(feed).toMatch(/8-K item 2.02/);
    expect(feed).toMatch(/-1.64/);
  });

  it('leaves an unrelated event type alone', async () => {
    const { agent } = await agentWith(
      earningsFiling(),
      llmReturning(bullishHypothesis),
      {},
      bookBlocking('bankruptcy', '8-K item 1.03'),
    );
    await agent.runCycle();
    expect(agent.getState().ordersPlaced).toBe(1);
  });
});

describe('cycle funnel', () => {
  it('records only an ingest step, with no reasons, when nothing was ingested', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    await agent.runCycle();

    const funnel = agent.getFunnels()[0]!;
    expect(funnel.cycleId).toBe(1);
    expect(funnel.steps).toEqual([{ stage: 'ingest', count: 0 }]);
    expect(funnel.summary).toBe('Documents ingested: none.');
  });

  it('reaches the orders stage when a cycle ends in a filled order', async () => {
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
    const { agent } = await agentWith(documents, llmReturning(bullishHypothesis));
    await agent.runCycle();

    const funnel = agent.getFunnels()[0]!;
    const stages = funnel.steps.map((s) => s.stage);
    expect(stages[0]).toBe('ingest');
    expect(stages[stages.length - 1]).toBe('orders');
    expect(funnel.steps.find((s) => s.stage === 'orders')?.count).toBe(1);
    expect(funnel.summary).toBe('1 order(s) placed.');
  });

  it('keeps history newest-first across multiple cycles', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    await agent.runCycle();
    await agent.runCycle();

    const funnels = agent.getFunnels();
    expect(funnels.map((f) => f.cycleId)).toEqual([2, 1]);
  });
});

describe('the daily analysis budget', () => {
  // Built inside each test, never at describe time: doc() resolves the source
  // against the registry, and beforeEach has not populated it during
  // collection. A document made too early has no tier and dies at ingestion.
  const documents = () => [
    doc(
      'sec_edgar',
      'Apple Inc. filed 8-K — Results of Operations',
      'Form 8-K filed by Apple Inc. Reported items: 2.02.',
      { form: '8-K', items: ['2.02'] },
      ['AAPL'],
    ),
    doc('outlet_a', 'Apple reports quarterly results above expectations', 'Earnings beat.', {}, ['AAPL']),
  ];

  it('does not stop when no ceiling is configured', async () => {
    // The default, and what this system did before the budget existed.
    const { agent } = await agentWith(documents(), llmCosting(bullishHypothesis, 5));
    await agent.runCycle();
    expect(agent.llmBudget.enforced).toBe(false);
    expect(agent.getState().signalsGenerated).toBeGreaterThan(0);
  });

  it('counts what the analysis actually cost', async () => {
    const { agent } = await agentWith(documents(), llmCosting(bullishHypothesis, 0.25), {
      MAX_DAILY_LLM_COST_USD: '10',
    });
    await agent.runCycle();
    expect(agent.llmBudget.spentUsd).toBeCloseTo(0.25, 6);
  });

  it('stops mid-cycle once the ceiling is crossed', async () => {
    // Two separate events, and a price that exhausts the day on the first.
    // The second must not be paid for: five analyses of a long document can
    // cross the line inside a single pass, so the check belongs between
    // events and not only between cycles.
    const { agent } = await agentWith(
      [
        ...documents(),
        doc('sec_edgar', 'Nvidia Inc. filed 8-K — Results of Operations', 'Form 8-K filed by Nvidia Inc. Reported items: 2.02.', { form: '8-K', items: ['2.02'] }, ['NVDA']),
        doc('outlet_a', 'Nvidia reports quarterly results above expectations', 'Earnings beat.', {}, ['NVDA']),
      ],
      llmCosting(bullishHypothesis, 2),
      { WATCHLIST: 'AAPL,NVDA', MAX_DAILY_LLM_COST_USD: '1' },
    );

    await agent.runCycle();

    expect(agent.getState().signalsGenerated).toBe(1);
    expect(agent.llmBudget.spentUsd).toBeCloseTo(2, 6);
    expect(agent.llmBudget.exhausted).toBe(true);
  });

  it('analyses nothing at all in a cycle that starts over budget', async () => {
    const { agent } = await agentWith(documents(), llmCosting(bullishHypothesis, 0.5), {
      MAX_DAILY_LLM_COST_USD: '1',
    });
    // Yesterday's spend, or an earlier cycle's — the agent cannot tell, and
    // must not analyse either way.
    agent.llmBudget.record(5);

    await agent.runCycle();

    expect(agent.getState().signalsGenerated).toBe(0);
    // Not one further dollar: the ceiling is checked before the first call.
    expect(agent.llmBudget.spentUsd).toBeCloseTo(5, 6);

    const funnel = agent.getFunnels()[0]!;
    const analysed = funnel.steps.find((step) => step.stage === 'analysed');
    expect(analysed?.count).toBe(0);
    expect(Object.keys(analysed?.reasons ?? {}).join()).toContain('budget');
  });

  it('keeps reading the news while analysis is paused', async () => {
    // Ingestion costs nothing. Halting it would mean losing the day's news
    // rather than the day's analysis, and the event store would fall behind.
    const { agent } = await agentWith(documents(), llmCosting(bullishHypothesis, 0.5), {
      MAX_DAILY_LLM_COST_USD: '1',
    });
    agent.llmBudget.record(5);

    await agent.runCycle();

    const funnel = agent.getFunnels()[0]!;
    expect(funnel.steps.find((step) => step.stage === 'ingest')?.count).toBeGreaterThan(0);
    expect(funnel.steps.find((step) => step.stage === 'events')?.count).toBeGreaterThan(0);
  });
});

describe('dashboard API', () => {
  it('exposes a diagnostic snapshot that never leaks a key', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-secret-value-12345' });
    const server = createApiServer({ agent, config });

    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/api/diagnostic`);
        resolve({ status: res.status, body: await res.text() });
        server.close();
      });
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.posture.summary.headline).toBeTypeOf('string');
    expect(body.funnels).toEqual([]);
    expect(response.body).not.toContain('sk-ant-secret-value-12345');
  });

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

  it('shows the two settings that decide whether anything can trade', async () => {
    // Read from a phone, these answer "is my change actually deployed?" —
    // which the funnel alone cannot, because a refusal looks the same either
    // way.
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const config = loadConfig({
      WATCHLIST: 'AAPL,MSFT',
      MIN_SIGNAL_SCORE: '0.3',
      ALLOW_MODEL_CHOSEN_ASSET: 'true',
    });
    const server = createApiServer({ agent, config });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('Min signal score');
    expect(body).toContain('0.3');
    expect(body).toContain('Model may pick the asset');
    // The universe is shown with it: a pick outside it is refused, so the
    // setting alone does not say what the model may actually choose.
    expect(body).toContain('AAPL, MSFT');
  });

  it('opens with a French briefing rather than the funnel table', async () => {
    // The person reading this did not build the pipeline: the first thing on
    // the page has to be a sentence, not a stage name.
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const server = createApiServer({ agent, config: loadConfig({}) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('Où en est le bot');
    expect(body).toContain('Aucun cycle n’a encore tourné');
    // The English stage names must not survive into the funnel table.
    expect(body).not.toContain('Passed analysis gate');
    expect(body).not.toContain('<th>Stage</th>');
  });

  it('names the empty feed set as the cause when nothing is being read', async () => {
    // The funnel showing "0 articles" cycle after cycle is the state an
    // operator stares at longest, and the cause was previously only in an
    // English note below the table. It belongs next to the symptom.
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    // A cycle has to have run: before the first one the honest answer is
    // "wait", not "your feed set is wrong".
    await agent.runCycle();
    const server = createApiServer({ agent, config: loadConfig({ ENABLED_SOURCES: '' }) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('seules les sources officielles sont activées');
    expect(body).toContain('ENABLED_SOURCES=all');
  });

  it('says plainly that Twitter is off, and what enabling it would not buy', async () => {
    // This project was described by its owner as "a bot that watches Twitter",
    // and X ingestion has never once run. The health table did say so — as the
    // word "disabled" in an English list of adapters, which is how someone can
    // believe the opposite for months. The briefing says it in a sentence.
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    await agent.runCycle();
    const server = createApiServer({ agent, config: loadConfig({}) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('Twitter / X : éteint.');
    // Not just "off": why turning it on would not do what he expects either.
    expect(body).toContain('écarté avant même d’être analysé');
  });

  it('waits for a first cycle before blaming anything', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const server = createApiServer({ agent, config: loadConfig({ ENABLED_SOURCES: '' }) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('Aucun cycle n’a encore tourné');
    // Not asserted on the bare setting name: the English coverage note below
    // the funnel already mentions it on every render, cycle or no cycle.
    expect(body).not.toContain('seules les sources officielles sont activées');
  });

  it('does not blame the feed set once company news is on', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    await agent.runCycle();
    const server = createApiServer({ agent, config: loadConfig({ ENABLED_SOURCES: 'all' }) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).not.toContain('seules les sources officielles sont activées');
  });

  it('says plainly when the model may not pick the asset', async () => {
    const { agent } = await agentWith([], llmReturning(bullishHypothesis));
    const server = createApiServer({ agent, config: loadConfig({}) });

    const body = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', async () => {
        const address = server.address() as { port: number };
        const res = await fetch(`http://127.0.0.1:${address.port}/`);
        resolve(await res.text());
        server.close();
      });
    });

    expect(body).toContain('an event with no ticker cannot trade');
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

describe('TradingAgent — an event that names no ticker', () => {
  /**
   * A macro, policy or sanctions story carries no company name, so detection
   * extracts no ticker. The analysis is still paid for and still journalled;
   * the question these tests pin down is whether it can reach an order, and on
   * what.
   */
  const macroDocuments = () => [
    doc(
      'outlet_a',
      'Fed raises interest rates by 50 basis points',
      'The central bank raised its policy rate, citing inflation.',
    ),
    doc(
      'sec_edgar',
      'Rate decision notice',
      'The policy rate was increased by 50 basis points.',
      { form: '8-K', items: ['8.01'] },
    ),
  ];

  /** The model reads a ticker-less story and names a symbol it can reach. */
  const proxyHypothesis = { ...bullishHypothesis, asset: 'AAPL', confidence: 0.8 };

  it('places no order by default, because the pick is an inference nobody opted into', async () => {
    const { agent } = await agentWith(macroDocuments(), llmReturning(proxyHypothesis));
    await agent.runCycle();
    // The analysis still happened and was still journalled — only the order is
    // withheld. Asserting that keeps this from passing for the wrong reason.
    expect(agent.getState().signalsGenerated).toBeGreaterThan(0);
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it("trades the model's pick when the operator turns it on", async () => {
    const { agent, journalPath } = await agentWith(macroDocuments(), llmReturning(proxyHypothesis), {
      ALLOW_MODEL_CHOSEN_ASSET: 'true',
      MIN_SIGNAL_SCORE: '0.3',
    });
    await agent.runCycle();

    expect(agent.getState().ordersPlaced).toBe(1);
    expect(agent.portfolio.openPositions[0]?.symbol).toBe('AAPL');

    const entry = JSON.parse((await readFile(journalPath, 'utf8')).trim().split('\n')[0]!);
    expect(entry.asset).toBe('AAPL');
  });

  it('refuses a pick outside the universe: the model selects, it does not extend', async () => {
    // TSLA is plausible and untradeable here — it is not on the watchlist.
    const { agent } = await agentWith(
      macroDocuments(),
      llmReturning({ ...proxyHypothesis, asset: 'TSLA' }),
      { ALLOW_MODEL_CHOSEN_ASSET: 'true', MIN_SIGNAL_SCORE: '0.3' },
    );
    await agent.runCycle();
    expect(agent.getState().signalsGenerated).toBeGreaterThan(0);
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it('still refuses a pick that cannot clear the score bar', async () => {
    // The proxy path changes which symbol is considered, never whether the
    // score has to be earned.
    const { agent } = await agentWith(macroDocuments(), llmReturning(proxyHypothesis), {
      ALLOW_MODEL_CHOSEN_ASSET: 'true',
      MIN_SIGNAL_SCORE: '0.99',
    });
    await agent.runCycle();
    expect(agent.getState().signalsGenerated).toBeGreaterThan(0);
    expect(agent.getState().ordersRejectedByRisk).toBeGreaterThan(0);
    expect(agent.getState().ordersPlaced).toBe(0);
  });

  it('does not act on a WATCH, however the asset field is filled', async () => {
    const { agent } = await agentWith(
      macroDocuments(),
      llmReturning({ ...proxyHypothesis, action: 'WATCH' }),
      { ALLOW_MODEL_CHOSEN_ASSET: 'true', MIN_SIGNAL_SCORE: '0.1' },
    );
    await agent.runCycle();
    expect(agent.getState().signalsGenerated).toBeGreaterThan(0);
    expect(agent.getState().ordersPlaced).toBe(0);
  });
});
