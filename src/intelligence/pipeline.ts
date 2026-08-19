import { type Clock, systemClock } from '../core/clock.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { NormalizedDocument } from '../domain/types.js';
import type { MarketDataService } from '../ingestion/market_data/index.js';
import { Metrics, metrics as globalMetrics } from '../monitoring/metrics.js';
import { materialityOf } from './event_detector/classifier.js';
import { clusterClassification, clusterDocuments, type ClusteringOptions } from './event_detector/clustering.js';
import type { EventStore } from './event-store.js';
import type { EventCluster, EventLink, MarketEvent } from './types.js';
import { measureMarketReaction } from './verification/market-reaction.js';
import { verifyCluster } from './verification/verifier.js';

/**
 * Phase 2 pipeline: normalised documents -> verified events.
 *
 *   documents -> classify -> cluster -> verify -> (optional) market reaction
 *
 * The output is an event with a truth-confidence and a full audit trail. It is
 * explicitly *not* a trading signal: nothing here decides direction, size or
 * whether to act. Phase 3 turns events into signal hypotheses; Phase 4 decides
 * whether any of it survives risk.
 */

export interface DetectOptions {
  clustering?: ClusteringOptions;
  /** Enables the market-reaction measurement. Requires price history. */
  marketData?: MarketDataService;
  /** Skip market reaction for events below this materiality. */
  marketReactionMinMateriality?: number;
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
}

export interface DetectionResult {
  events: MarketEvent[];
  stats: {
    documents: number;
    clusters: number;
    newEvents: number;
    updatedEvents: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    contradicted: number;
    durationMs: number;
  };
}

function buildHeadline(cluster: EventCluster): { headline: string; summary: string } {
  // Prefer the most reliable source's wording: an issuer's own filing describes
  // its event better than a headline written about it.
  const ranked = [...cluster.documents].sort((a, b) => b.source_reliability - a.source_reliability);
  const best = ranked[0]!;
  return {
    headline: best.title || best.content.slice(0, 120),
    summary: best.content.slice(0, 600),
  };
}

export async function detectEvents(
  documents: NormalizedDocument[],
  store: EventStore,
  options: DetectOptions = {},
): Promise<DetectionResult> {
  const clock = options.clock ?? systemClock;
  const log = options.logger ?? createLogger('event-detector');
  const m = options.metrics ?? globalMetrics;
  const startedAt = clock.nowMs();

  const clusters = clusterDocuments(documents, options.clustering ?? {});
  const events: MarketEvent[] = [];
  let newEvents = 0;
  let updatedEvents = 0;

  for (const cluster of clusters) {
    const classification = clusterClassification(cluster);
    const bestReliability = cluster.documents.reduce(
      (max, doc) => Math.max(max, doc.source_reliability),
      0,
    );
    const materiality = materialityOf(classification, {
      sourceReliability: bestReliability,
      hasTickers: cluster.tickers.length > 0,
      hasEntities: cluster.entities.length > 0,
    });

    // Measuring market reaction costs API calls, so it is reserved for events
    // that could plausibly matter and that name a specific asset.
    const symbol = cluster.tickers[0];
    const wantsReaction =
      options.marketData !== undefined &&
      symbol !== undefined &&
      materiality >= (options.marketReactionMinMateriality ?? 0.5);

    const marketReaction = wantsReaction
      ? await measureMarketReaction(options.marketData!, symbol, cluster.firstSeenAt, { clock, logger: log })
      : undefined;

    const verification = verifyCluster(cluster, {
      ...(marketReaction ? { marketReaction } : {}),
    });

    const { headline, summary } = buildHeadline(cluster);
    const event: MarketEvent = {
      id: cluster.id,
      type: cluster.type,
      headline,
      summary,
      firstSeenAt: cluster.firstSeenAt,
      lastUpdatedAt: cluster.lastUpdatedAt,
      entities: cluster.entities,
      tickers: cluster.tickers,
      jurisdictions: cluster.jurisdictions,
      documentIds: cluster.documents.map((doc) => doc.id),
      sources: [...new Set(cluster.documents.map((doc) => doc.source))],
      links: linksFor(cluster.documents),
      classification,
      materiality,
      verification,
    };

    const { created, event: stored } = await store.upsert(event);
    if (created) newEvents += 1;
    else updatedEvents += 1;
    events.push(stored);

    m.increment('events.detected', 1, { type: event.type, status: verification.status });
    if (verification.contradictions.length > 0) {
      log.warn(
        {
          eventId: event.id,
          type: event.type,
          contradictions: verification.contradictions.map((c) => c.matchedPattern),
        },
        'event carries contradiction signals — not actionable without review',
      );
    }
  }

  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byStatus[event.verification.status] = (byStatus[event.verification.status] ?? 0) + 1;
  }

  return {
    events: events.sort((a, b) => b.materiality - a.materiality),
    stats: {
      documents: documents.length,
      clusters: clusters.length,
      newEvents,
      updatedEvents,
      byType,
      byStatus,
      contradicted: events.filter((e) => e.verification.status === 'contradicted').length,
      durationMs: clock.nowMs() - startedAt,
    },
  };
}

/**
 * The documents behind an event, as openable links.
 *
 * Deduplicated by URL and capped: a cluster of syndications of one story is
 * one story, and a list of forty links would claim otherwise. Documents whose
 * source gave no URL are skipped rather than rendered as dead entries — an
 * event with no readable source should look like it has none.
 */
const MAX_LINKS = 6;

export function linksFor(documents: NormalizedDocument[]): EventLink[] {
  const seen = new Set<string>();
  const links: EventLink[] = [];

  for (const doc of documents) {
    if (!doc.url || seen.has(doc.url)) continue;
    seen.add(doc.url);
    links.push({
      source: doc.source,
      title: doc.title,
      url: doc.url,
      publishedAt: doc.published_at,
    });
    if (links.length >= MAX_LINKS) break;
  }

  return links;
}

export interface AnalysisGateResult {
  kept: MarketEvent[];
  /** Why the rest were dropped, reason -> count. Empty when nothing was dropped. */
  droppedByReason: Record<string, number>;
}

/**
 * Events worth passing to Phase 3 analysis.
 *
 * A deliberately blunt gate: contradicted events never proceed, and everything
 * else must clear both a materiality and a confidence floor. Its purpose is to
 * avoid spending LLM calls on noise, not to decide anything about trading.
 *
 * Returns the drop reason alongside the survivors, from the same pass over
 * the same events, so the reported reasons can never drift from what the
 * filter actually did — a filter and a separately-computed explanation of it
 * are two implementations of one rule, and two implementations disagree
 * eventually.
 */
export function evaluateAnalysisGate(
  events: MarketEvent[],
  options: { minMateriality?: number; minConfidence?: number } = {},
): AnalysisGateResult {
  const minMateriality = options.minMateriality ?? 0.4;
  const minConfidence = options.minConfidence ?? 0.5;

  const kept: MarketEvent[] = [];
  const droppedByReason: Record<string, number> = {};
  const drop = (reason: string) => {
    droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1;
  };

  for (const event of events) {
    if (event.verification.status === 'contradicted') {
      drop('contradicted');
    } else if (event.type === 'unclassified') {
      drop('unclassified');
    } else if (event.materiality < minMateriality) {
      drop(`materiality below ${minMateriality}`);
    } else if (event.verification.confidence < minConfidence) {
      drop(`confidence below ${minConfidence}`);
    } else {
      kept.push(event);
    }
  }

  return { kept, droppedByReason };
}
