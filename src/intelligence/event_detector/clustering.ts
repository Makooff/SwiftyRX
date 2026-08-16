import { sha256 } from '../../core/hash.js';
import type { Entity, NormalizedDocument } from '../../domain/types.js';
import {
  jurisdictionsFromEntities,
  resolveDocumentEntities,
  tickersFromEntities,
} from '../entity_resolution/resolver.js';
import type { Classification, EventCluster } from '../types.js';
import { classifyDocument } from './classifier.js';
import { CONTRADICTION_PATTERNS } from './rules.js';

/**
 * Event clustering.
 *
 * Groups documents that describe the same real-world event. This is the
 * semantic step that Phase 1's deduplication deliberately did not attempt:
 * dedup matches text, clustering matches *subject*.
 *
 * The join rule is intentionally conservative — same event type, overlapping
 * entities, inside a time window. Over-merging is the dangerous failure: two
 * distinct events fused into one produce a single event carrying the combined
 * apparent corroboration of both, which is exactly the kind of inflated
 * confidence the verification stage exists to prevent.
 */

export interface ClusteringOptions {
  /** How far apart two documents can be and still describe one event. */
  windowHours?: number;
}

const DEFAULT_WINDOW_HOURS = 36;

function documentTime(doc: NormalizedDocument): number {
  const published = doc.published_at ? Date.parse(doc.published_at) : Number.NaN;
  if (!Number.isNaN(published)) return published;
  return Date.parse(doc.retrieved_at);
}

function entityKeys(entities: Entity[]): Set<string> {
  return new Set(entities.map((e) => e.id ?? e.text.toLowerCase()).filter(Boolean));
}

/**
 * Whether a document uses denial, retraction or correction language.
 *
 * Used only to decide *where* the document belongs. Whether it genuinely
 * refutes the cluster's claim is the verifier's call, and a match there flags
 * the event for review rather than resolving the disagreement.
 */
export function hasDenialLanguage(doc: NormalizedDocument): boolean {
  const text = `${doc.title} ${doc.content}`;
  return CONTRADICTION_PATTERNS.some(({ pattern }) => pattern.test(text));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const key of small) if (large.has(key)) return true;
  return false;
}

interface WorkingCluster extends EventCluster {
  entityKeys: Set<string>;
  documentIds: Set<string>;
}

export function clusterDocuments(
  docs: NormalizedDocument[],
  options: ClusteringOptions = {},
): EventCluster[] {
  const windowMs = (options.windowHours ?? DEFAULT_WINDOW_HOURS) * 3_600_000;

  // Chronological order, so the earliest report of an event seeds its cluster
  // and later coverage joins it. Processing out of order would let a late
  // follow-up define the event's start time.
  const ordered = [...docs].sort((a, b) => documentTime(a) - documentTime(b));
  const clusters: WorkingCluster[] = [];

  for (const doc of ordered) {
    const classification = classifyDocument(doc);
    const entities = resolveDocumentEntities(doc);
    const keys = entityKeys(entities);
    const timestamp = documentTime(doc);

    // A denial talks about someone else's claim, and usually does not repeat
    // the vocabulary that classified it — "X denies the report" carries no
    // merger language at all. Requiring a type match would file the denial as
    // its own unclassified event and leave the claim it refutes looking
    // unchallenged, which is the exact failure this stage must not have.
    const isDenial = hasDenialLanguage(doc);

    const target = clusters.find((cluster) => {
      if (!isDenial && cluster.type !== classification.type) return false;

      // A near-duplicate belongs with whatever it duplicates, regardless of
      // entity overlap: dedup already established they carry the same text.
      if (doc.duplicateOf && cluster.documentIds.has(doc.duplicateOf)) return true;

      const withinWindow = timestamp - Date.parse(cluster.lastUpdatedAt) <= windowMs;
      if (!withinWindow) return false;

      // A denial still has to be about the same subject; entity overlap is the
      // only thing preventing it from attaching to an unrelated event.
      if (isDenial) return keys.size > 0 && intersects(keys, cluster.entityKeys);

      // Entity-less events (a macro release with no named issuer) join on type
      // and jurisdiction alone; requiring entity overlap would scatter them.
      if (keys.size === 0 && cluster.entityKeys.size === 0) return true;

      return intersects(keys, cluster.entityKeys);
    });

    if (target) {
      target.documents.push(doc);
      target.documentIds.add(doc.id);
      target.classifications.push(classification);
      for (const key of keys) target.entityKeys.add(key);
      mergeEntities(target.entities, entities);
      target.tickers = [...new Set([...target.tickers, ...doc.tickers, ...tickersFromEntities(entities)])];
      target.jurisdictions = [
        ...new Set([...target.jurisdictions, ...jurisdictionsFromEntities(entities)]),
      ];
      target.lastUpdatedAt = new Date(Math.max(Date.parse(target.lastUpdatedAt), timestamp)).toISOString();
      continue;
    }

    const iso = new Date(timestamp).toISOString();
    clusters.push({
      // Deterministic id: the same seed document always yields the same
      // cluster id, so events survive a restart with stable identity.
      id: sha256(`${doc.id}|${classification.type}`).slice(0, 24),
      type: classification.type,
      documents: [doc],
      documentIds: new Set([doc.id]),
      entities: [...entities],
      entityKeys: keys,
      tickers: [...new Set([...doc.tickers, ...tickersFromEntities(entities)])],
      jurisdictions: jurisdictionsFromEntities(entities),
      firstSeenAt: iso,
      lastUpdatedAt: iso,
      classifications: [classification],
    });
  }

  return clusters.map(({ entityKeys: _keys, documentIds: _ids, ...cluster }) => cluster);
}

function mergeEntities(target: Entity[], incoming: Entity[]): void {
  for (const entity of incoming) {
    const key = entity.id ?? entity.text.toLowerCase();
    const existing = target.find((e) => (e.id ?? e.text.toLowerCase()) === key);
    if (!existing) {
      target.push(entity);
    } else if (entity.confidence > existing.confidence) {
      existing.confidence = entity.confidence;
    }
  }
}

/**
 * The cluster's overall classification: the highest-confidence one among its
 * documents, since a filing's item code should win over a headline's keywords.
 */
export function clusterClassification(cluster: EventCluster): Classification {
  return cluster.classifications.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );
}
