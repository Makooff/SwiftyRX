import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import { classifyDocument, materialityOf } from '../src/intelligence/event_detector/classifier.js';
import { clusterDocuments } from '../src/intelligence/event_detector/clustering.js';
import { resolveEntities, tickersFromEntities } from '../src/intelligence/entity_resolution/resolver.js';
import { MemoryEventStore } from '../src/intelligence/event-store.js';
import { detectEvents, eventsWorthAnalysing } from '../src/intelligence/pipeline.js';
import { verifyCluster } from '../src/intelligence/verification/verifier.js';
import type { EventCluster } from '../src/intelligence/types.js';

const clock = FixedClock.at('2026-08-16T12:00:00Z');

beforeEach(() => {
  sourceRegistry.clear();
  sourceRegistry.registerAll([
    describeSource({ id: 'sec_edgar', name: 'SEC EDGAR', tier: 'regulatory_filing', jurisdiction: 'US' }),
    describeSource({ id: 'ecb_press', name: 'ECB press', tier: 'official', jurisdiction: 'EU' }),
    describeSource({ id: 'outlet_a', name: 'Outlet A', tier: 'news', jurisdiction: 'US' }),
    describeSource({ id: 'outlet_b', name: 'Outlet B', tier: 'news', jurisdiction: 'US' }),
    describeSource({ id: 'outlet_c', name: 'Outlet C', tier: 'news', jurisdiction: 'GB' }),
    describeSource({ id: 'x:@someone', name: 'X @someone', tier: 'social', reliability: 0.2 }),
    describeSource({ id: 'x:@another', name: 'X @another', tier: 'social', reliability: 0.2 }),
  ]);
});

interface DocOptions {
  source: string;
  title: string;
  content?: string;
  publishedAt?: string;
  tickers?: string[];
  metadata?: Record<string, unknown>;
  duplicateOf?: string;
}

function doc(options: DocOptions): NormalizedDocument {
  const normalised = normalizeDocument(
    {
      sourceId: options.source,
      externalId: `${options.source}:${options.title}`,
      title: options.title,
      content: options.content ?? options.title,
      ...(options.publishedAt ? { publishedAt: options.publishedAt } : { publishedAt: '2026-08-16T10:00:00Z' }),
      retrievedAt: clock.now().toISOString(),
      raw: {},
    },
    {
      clock,
      ...(options.tickers ? { declaredTickers: options.tickers } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  );
  return options.duplicateOf ? { ...normalised, duplicateOf: options.duplicateOf } : normalised;
}

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

describe('entity resolution', () => {
  it('resolves declared tickers with high confidence', () => {
    const entities = resolveEntities('Quarterly results released', { declaredTickers: ['NVDA'] });
    const nvda = entities.find((e) => e.id === 'NVDA');
    expect(nvda?.confidence).toBeGreaterThan(0.9);
  });

  it('resolves company names and aliases from text', () => {
    const entities = resolveEntities('Apple said the Governing Council decision affects its outlook');
    expect(entities.map((e) => e.id)).toContain('AAPL');
    expect(entities.map((e) => e.id)).toContain('ECB');
  });

  it('scores aliases lower than full names', () => {
    const alias = resolveEntities('Nvidia announced a partnership').find((e) => e.id === 'NVDA');
    const full = resolveEntities('NVIDIA Corporation announced a partnership').find((e) => e.id === 'NVDA');
    expect(full!.confidence).toBeGreaterThan(alias!.confidence);
  });

  it('does not match an alias inside a longer word', () => {
    // "Fed" must not fire on "federated" or "fedora".
    const entities = resolveEntities('The federated learning model uses a fedora container');
    expect(entities.map((e) => e.id)).not.toContain('FED');
  });

  it('matches terms containing punctuation', () => {
    const entities = resolveEntities('The U.S. imposed new measures');
    expect(entities.map((e) => e.id)).toContain('US');
  });

  it('maps company entities to tickers but not countries', () => {
    const withCompany = resolveEntities('Microsoft and China issued statements');
    const tickers = tickersFromEntities(withCompany);
    expect(tickers).toContain('MSFT');
    // "tariffs on China -> sell these tickers" is an impact judgement, not a
    // resolution fact, so country entities map to no tickers here.
    expect(tickers).toHaveLength(1);
  });

  it('returns nothing for text with no known entities', () => {
    expect(resolveEntities('A quiet day with no notable developments')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classification', () => {
  it('classifies an 8-K item 2.02 as earnings', () => {
    const result = classifyDocument(
      doc({
        source: 'sec_edgar',
        title: 'Apple Inc. filed 8-K',
        content: 'Form 8-K filed by Apple Inc.',
        metadata: { form: '8-K', items: ['2.02', '9.01'] },
      }),
    );
    expect(result.type).toBe('earnings');
    expect(result.matched.map((m) => m.rule)).toContain('sec:item:2.02');
  });

  it('classifies an item 5.02 as an executive change', () => {
    const result = classifyDocument(
      doc({ source: 'sec_edgar', title: 'Filed 8-K', metadata: { form: '8-K', items: '5.02' } }),
    );
    expect(result.type).toBe('executive_change');
  });

  it('ignores item 9.01, which only signals attached exhibits', () => {
    const result = classifyDocument(
      doc({ source: 'sec_edgar', title: 'Filed 8-K', metadata: { form: '8-K', items: ['9.01'] } }),
    );
    expect(result.type).toBe('unclassified');
  });

  it('classifies a 10-Q as a periodic report', () => {
    const result = classifyDocument(
      doc({ source: 'sec_edgar', title: 'Filed 10-Q', metadata: { form: '10-Q' } }),
    );
    expect(result.type).toBe('periodic_report');
  });

  it('classifies a rate decision from text', () => {
    const result = classifyDocument(
      doc({
        source: 'ecb_press',
        title: 'Monetary policy decisions',
        content: 'The Governing Council decided to lower the three key ECB interest rates by 25 basis points.',
      }),
    );
    expect(result.type).toBe('monetary_policy');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies tariff announcements as trade policy', () => {
    const result = classifyDocument(
      doc({ source: 'outlet_a', title: 'New tariffs announced on imported semiconductors' }),
    );
    expect(result.type).toBe('trade_policy');
  });

  it('returns unclassified rather than guessing', () => {
    const result = classifyDocument(doc({ source: 'outlet_a', title: 'A general update about nothing specific' }));
    expect(result.type).toBe('unclassified');
    expect(result.confidence).toBe(0);
  });

  it('records every rule that fired, for auditing', () => {
    const result = classifyDocument(
      doc({
        source: 'ecb_press',
        title: 'ECB raises interest rates by 25 basis points',
        content: 'The Governing Council took the policy rate decision today.',
      }),
    );
    expect(result.matched.length).toBeGreaterThan(1);
    expect(result.matched.every((m) => m.rule.length > 0)).toBe(true);
  });

  it('lowers confidence when two event types match about equally', () => {
    const focused = classifyDocument(
      doc({ source: 'outlet_a', title: 'New tariffs and import duties announced' }),
    );
    const ambiguous = classifyDocument(
      doc({
        source: 'outlet_a',
        title: 'New tariffs announced as company reports quarterly results',
        content: 'Tariffs were announced. Separately, earnings per share came in ahead.',
      }),
    );
    expect(ambiguous.confidence).toBeLessThan(focused.confidence);
  });
});

describe('materiality', () => {
  it('rates a monetary policy decision above a product launch', () => {
    const policy = materialityOf(
      { type: 'monetary_policy', confidence: 0.9, matched: [] },
      { sourceReliability: 0.98, hasTickers: false, hasEntities: true },
    );
    const product = materialityOf(
      { type: 'product', confidence: 0.9, matched: [] },
      { sourceReliability: 0.98, hasTickers: true, hasEntities: true },
    );
    expect(policy).toBeGreaterThan(product);
  });

  it('discounts events that name no asset or entity', () => {
    const named = materialityOf(
      { type: 'earnings', confidence: 0.9, matched: [] },
      { sourceReliability: 0.9, hasTickers: true, hasEntities: true },
    );
    const vague = materialityOf(
      { type: 'earnings', confidence: 0.9, matched: [] },
      { sourceReliability: 0.9, hasTickers: false, hasEntities: false },
    );
    expect(vague).toBeLessThan(named);
  });

  it('discounts unreliable sources', () => {
    const official = materialityOf(
      { type: 'trade_policy', confidence: 0.8, matched: [] },
      { sourceReliability: 0.98, hasTickers: true, hasEntities: true },
    );
    const social = materialityOf(
      { type: 'trade_policy', confidence: 0.8, matched: [] },
      { sourceReliability: 0.2, hasTickers: true, hasEntities: true },
    );
    expect(social).toBeLessThan(official);
  });
});

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

describe('clustering', () => {
  it('groups reports about the same event from different outlets', () => {
    const clusters = clusterDocuments([
      doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup', publishedAt: '2026-08-16T09:00:00Z' }),
      doc({ source: 'outlet_b', title: 'Apple confirms acquisition of robotics firm', publishedAt: '2026-08-16T10:00:00Z' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.documents).toHaveLength(2);
  });

  it('keeps events about different companies apart', () => {
    const clusters = clusterDocuments([
      doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' }),
      doc({ source: 'outlet_b', title: 'Microsoft to acquire a security vendor' }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('keeps different event types about one company apart', () => {
    const clusters = clusterDocuments([
      doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' }),
      doc({
        source: 'sec_edgar',
        title: 'Apple Inc. filed 8-K',
        metadata: { form: '8-K', items: ['2.02'] },
        tickers: ['AAPL'],
      }),
    ]);
    expect(clusters.length).toBeGreaterThan(1);
  });

  it('does not merge reports separated by more than the window', () => {
    const clusters = clusterDocuments(
      [
        doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup', publishedAt: '2026-08-01T09:00:00Z' }),
        doc({ source: 'outlet_b', title: 'Apple to acquire a robotics startup', publishedAt: '2026-08-16T09:00:00Z' }),
      ],
      { windowHours: 24 },
    );
    expect(clusters).toHaveLength(2);
  });

  it('attaches a denial to the event it contradicts, not to its own cluster', () => {
    // A denial rarely repeats the vocabulary that classified the claim, so
    // type-matching alone would file it separately and leave the original
    // claim looking unchallenged.
    const clusters = clusterDocuments([
      doc({ source: 'outlet_a', title: 'Microsoft to acquire a security vendor', tickers: ['MSFT'] }),
      doc({
        source: 'outlet_b',
        title: 'Microsoft denies reports of the security vendor acquisition',
        content: 'The company said the report is without merit.',
        tickers: ['MSFT'],
        publishedAt: '2026-08-16T11:00:00Z',
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.type).toBe('m_and_a');
    expect(clusters[0]!.documents).toHaveLength(2);
  });

  it('does not attach a denial to an unrelated event', () => {
    const clusters = clusterDocuments([
      doc({ source: 'outlet_a', title: 'Microsoft to acquire a security vendor', tickers: ['MSFT'] }),
      doc({
        source: 'outlet_b',
        title: 'Apple denies reports about its supply chain',
        content: 'Apple said the claim is without merit.',
        tickers: ['AAPL'],
        publishedAt: '2026-08-16T11:00:00Z',
      }),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('produces a stable id for the same seed document', () => {
    const input = [doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' })];
    expect(clusterDocuments(input)[0]!.id).toBe(clusterDocuments(input)[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function clusterOf(documents: NormalizedDocument[]): EventCluster {
  return {
    id: 'test-cluster',
    type: 'm_and_a',
    documents,
    entities: [],
    tickers: ['AAPL'],
    jurisdictions: ['US'],
    firstSeenAt: '2026-08-16T09:00:00Z',
    lastUpdatedAt: '2026-08-16T10:00:00Z',
    classifications: [{ type: 'm_and_a', confidence: 0.7, matched: [] }],
  };
}

describe('verification', () => {
  it('marks an event officially confirmed when a filing is present', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'outlet_a', title: 'Apple said to be acquiring a robotics startup' }),
        doc({ source: 'sec_edgar', title: 'Apple Inc. filed 8-K', metadata: { form: '8-K', items: ['2.01'] } }),
      ]),
    );
    expect(assessment.status).toBe('officially_confirmed');
    expect(assessment.authoritativeSources).toContain('sec_edgar');
    expect(assessment.confidence).toBeGreaterThan(0.9);
  });

  it('marks an event corroborated with two independent outlets', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' }),
        doc({ source: 'outlet_b', title: 'Apple acquiring robotics firm, sources say' }),
      ]),
    );
    expect(assessment.status).toBe('corroborated');
    expect(assessment.independentReports).toBe(2);
  });

  it('leaves a single unconfirmed report unverified and capped', () => {
    const assessment = verifyCluster(
      clusterOf([doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' })]),
    );
    expect(assessment.status).toBe('unverified');
    expect(assessment.confidence).toBeLessThanOrEqual(0.6);
  });

  it('does not treat syndicated republication as corroboration', () => {
    const original = doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' });
    const republished = doc({
      source: 'outlet_b',
      title: 'Apple to acquire a robotics startup',
      duplicateOf: original.id,
    });

    const assessment = verifyCluster(clusterOf([original, republished]));
    // Two outlets, one newsroom: the claim was not independently established.
    expect(assessment.independentReports).toBe(1);
    expect(assessment.status).toBe('unverified');
    expect(assessment.reasons.join(' ')).toContain('syndication is not corroboration');
    // Wide republication must not lift the claim past the single-report cap.
    expect(assessment.confidence).toBeLessThanOrEqual(0.6);
  });

  it('caps social-only clusters however many accounts repeat the claim', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'x:@someone', title: 'BREAKING: Apple acquiring a robotics startup' }),
        doc({ source: 'x:@another', title: 'Confirmed: Apple buying robotics startup' }),
      ]),
    );
    expect(assessment.confidence).toBeLessThanOrEqual(0.35);
    expect(assessment.status).not.toBe('officially_confirmed');
  });

  it('flags denials as contradicted', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' }),
        doc({ source: 'outlet_b', title: 'Apple denies reports of a robotics acquisition' }),
      ]),
    );
    expect(assessment.status).toBe('contradicted');
    expect(assessment.contradictions).toHaveLength(1);
    expect(assessment.confidence).toBeLessThan(0.6);
  });

  it('lets an official source outrank a media denial, but records the conflict', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'sec_edgar', title: 'Apple Inc. filed 8-K', metadata: { form: '8-K', items: ['2.01'] } }),
        doc({ source: 'outlet_b', title: 'Report denies the acquisition took place' }),
      ]),
    );
    expect(assessment.status).toBe('officially_confirmed');
    expect(assessment.contradictions.length).toBeGreaterThan(0);
    expect(assessment.reasons.join(' ')).toContain('flagged for review');
  });

  it('records an unscored market reaction for an unverified claim', () => {
    const assessment = verifyCluster(clusterOf([doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' })]), {
      marketReaction: {
        symbol: 'AAPL',
        windowStart: '2026-08-16T09:00:00Z',
        windowEnd: '2026-08-16T20:00:00Z',
        returnPct: 4.2,
        volumeRatio: 3.1,
        abnormal: true,
        provider: 'test',
        note: 'test',
      },
    });

    // Otherwise a rumour moves the price and the move then "confirms" the
    // rumour. The reaction is recorded, not scored.
    expect(assessment.marketReaction?.abnormal).toBe(true);
    expect(assessment.confidence).toBeLessThanOrEqual(0.6);
    expect(assessment.reasons.join(' ')).toContain('not scored');
  });

  it('explains every adjustment it made', () => {
    const assessment = verifyCluster(
      clusterOf([
        doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup' }),
        doc({ source: 'outlet_b', title: 'Apple acquiring robotics firm, sources say' }),
      ]),
    );
    expect(assessment.reasons.length).toBeGreaterThan(1);
    expect(assessment.reasons.join(' ')).toContain('base = best source reliability');
  });
});

// ---------------------------------------------------------------------------
// End-to-end detection
// ---------------------------------------------------------------------------

describe('detectEvents', () => {
  it('turns documents into verified events', async () => {
    const store = new MemoryEventStore(clock);
    const { events, stats } = await detectEvents(
      [
        doc({
          source: 'sec_edgar',
          title: 'Apple Inc. filed 8-K — Results of Operations',
          content: 'Form 8-K filed by Apple Inc. Reported items: 2.02.',
          metadata: { form: '8-K', items: ['2.02'] },
          tickers: ['AAPL'],
        }),
        doc({ source: 'outlet_a', title: 'Apple reports quarterly results ahead of expectations', tickers: ['AAPL'] }),
      ],
      store,
      { clock },
    );

    expect(stats.documents).toBe(2);
    expect(events.length).toBeGreaterThan(0);
    const earnings = events.find((e) => e.type === 'earnings');
    expect(earnings).toBeDefined();
    expect(earnings!.verification.status).toBe('officially_confirmed');
    expect(earnings!.tickers).toContain('AAPL');
  });

  it('persists events and updates rather than duplicating them', async () => {
    const store = new MemoryEventStore(clock);
    const documents = [
      doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup', tickers: ['AAPL'] }),
    ];

    const first = await detectEvents(documents, store, { clock });
    expect(first.stats.newEvents).toBe(1);

    const second = await detectEvents(documents, store, { clock });
    expect(second.stats.newEvents).toBe(0);
    expect(second.stats.updatedEvents).toBe(1);
    expect(await store.size()).toBe(1);
  });

  it('never lets an unverified social post clear the analysis gate', async () => {
    const store = new MemoryEventStore(clock);
    const { events } = await detectEvents(
      [doc({ source: 'x:@someone', title: 'BREAKING: new tariffs on all semiconductor imports', tickers: ['NVDA'] })],
      store,
      { clock },
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.verification.confidence).toBeLessThanOrEqual(0.35);
    // The single most important guarantee in this phase.
    expect(eventsWorthAnalysing(events)).toHaveLength(0);
  });

  it('excludes contradicted events from analysis', async () => {
    const store = new MemoryEventStore(clock);
    const { events } = await detectEvents(
      [
        doc({ source: 'outlet_a', title: 'Apple to acquire a robotics startup', tickers: ['AAPL'] }),
        doc({ source: 'outlet_b', title: 'Apple denies the acquisition report', tickers: ['AAPL'] }),
      ],
      store,
      { clock },
    );

    // The denial must land on the acquisition event itself, so the claim it
    // refutes is the thing marked contradicted.
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('m_and_a');
    expect(events[0]!.verification.status).toBe('contradicted');
    expect(eventsWorthAnalysing(events)).toHaveLength(0);
  });

  it('passes a confirmed, material event to analysis', async () => {
    const store = new MemoryEventStore(clock);
    const { events } = await detectEvents(
      [
        doc({
          source: 'ecb_press',
          title: 'Monetary policy decisions',
          content: 'The Governing Council decided to lower the three key ECB interest rates by 25 basis points.',
        }),
      ],
      store,
      { clock },
    );

    const worth = eventsWorthAnalysing(events);
    expect(worth).toHaveLength(1);
    expect(worth[0]!.type).toBe('monetary_policy');
  });
});
