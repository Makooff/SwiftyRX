import { type Clock, systemClock } from '../core/clock.js';
import { jaccard, shingles } from '../core/hash.js';
import type { NormalizedDocument } from '../domain/types.js';

/**
 * Deduplication.
 *
 * Two distinct jobs:
 *  - Exact duplicates: the same document polled twice. Dropped.
 *  - Near duplicates: republished or lightly edited copies of the same text —
 *    syndicated wire copy, a corrected headline, the same release on two
 *    feeds. Kept, but linked, because independent outlets carrying the same
 *    claim is exactly the corroboration signal the verification stage needs.
 *    Collapsing them would destroy that evidence.
 *
 * Scope limit worth being explicit about: this matches *text*, not meaning.
 * Two outlets describing one event in their own words will not match here, and
 * should not — grouping distinct write-ups of the same event is semantic
 * clustering, which belongs to event detection in Phase 2.
 */

export interface DedupResult {
  document: NormalizedDocument;
  status: 'new' | 'exact_duplicate' | 'near_duplicate';
  /** Id of the first document that carried this content. */
  originalId?: string;
  similarity?: number;
}

export interface DedupOptions {
  /** Jaccard threshold above which two documents describe the same story. */
  similarityThreshold?: number;
  /** How long a document stays in the comparison window. */
  windowSeconds?: number;
  maxEntries?: number;
  clock?: Clock;
}

interface Seen {
  id: string;
  source: string;
  contentHash: string;
  shingles: Set<string>;
  seenAtMs: number;
}

/**
 * Word-shingle width. Bigrams tolerate the small edits that republication
 * introduces (an inserted article, a reordered clause) where trigrams do not.
 */
const SHINGLE_SIZE = 2;

export class Deduplicator {
  private readonly byHash = new Map<string, string>();
  private readonly recent: Seen[] = [];
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;

  constructor(options: DedupOptions = {}) {
    this.threshold = options.similarityThreshold ?? 0.7;
    this.windowMs = (options.windowSeconds ?? 48 * 3600) * 1000;
    this.maxEntries = options.maxEntries ?? 5_000;
    this.clock = options.clock ?? systemClock;
  }

  private prune(): void {
    const cutoff = this.clock.nowMs() - this.windowMs;
    while (this.recent.length > 0 && this.recent[0]!.seenAtMs < cutoff) {
      const dropped = this.recent.shift()!;
      if (this.byHash.get(dropped.contentHash) === dropped.id) {
        this.byHash.delete(dropped.contentHash);
      }
    }
    while (this.recent.length > this.maxEntries) {
      const dropped = this.recent.shift()!;
      if (this.byHash.get(dropped.contentHash) === dropped.id) {
        this.byHash.delete(dropped.contentHash);
      }
    }
  }

  inspect(doc: NormalizedDocument): DedupResult {
    this.prune();

    const exact = this.byHash.get(doc.contentHash);
    if (exact !== undefined && exact !== doc.id) {
      return { document: doc, status: 'exact_duplicate', originalId: exact, similarity: 1 };
    }
    if (exact === doc.id) {
      return { document: doc, status: 'exact_duplicate', originalId: exact, similarity: 1 };
    }

    const fingerprint = shingles(`${doc.title} ${doc.content.slice(0, 2000)}`, SHINGLE_SIZE);
    let best: { id: string; score: number } | undefined;
    for (const seen of this.recent) {
      const score = jaccard(fingerprint, seen.shingles);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { id: seen.id, score };
      }
    }

    this.byHash.set(doc.contentHash, doc.id);
    this.recent.push({
      id: doc.id,
      source: doc.source,
      contentHash: doc.contentHash,
      shingles: fingerprint,
      seenAtMs: this.clock.nowMs(),
    });

    if (best) {
      return {
        // Linked, not dropped: corroboration across outlets is evidence.
        document: { ...doc, duplicateOf: best.id },
        status: 'near_duplicate',
        originalId: best.id,
        similarity: best.score,
      };
    }

    return { document: doc, status: 'new' };
  }

  /** Filter a batch, dropping exact duplicates and linking near duplicates. */
  process(docs: NormalizedDocument[]): { kept: NormalizedDocument[]; results: DedupResult[] } {
    const results = docs.map((doc) => this.inspect(doc));
    return {
      kept: results.filter((r) => r.status !== 'exact_duplicate').map((r) => r.document),
      results,
    };
  }

  get size(): number {
    return this.recent.length;
  }
}
