import { type Clock, systemClock } from '../core/clock.js';
import type { MarketEvent } from './types.js';

/**
 * In-memory event store.
 *
 * Phase 2 keeps events in memory; the interface is what Phase 3+ will back with
 * PostgreSQL when the decision journal needs durability. Events are retained
 * for a window so that a late report can update an event detected in an earlier
 * cycle rather than creating a second, apparently-independent one.
 */

export interface EventStore {
  upsert(event: MarketEvent): Promise<{ created: boolean; event: MarketEvent }>;
  get(id: string): Promise<MarketEvent | undefined>;
  recent(options?: { since?: Date; limit?: number }): Promise<MarketEvent[]>;
  size(): Promise<number>;
}

export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, MarketEvent>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly retentionHours = 30 * 24,
  ) {}

  private prune(): void {
    const cutoff = this.clock.nowMs() - this.retentionHours * 3_600_000;
    for (const [id, event] of this.events) {
      if (Date.parse(event.lastUpdatedAt) < cutoff) this.events.delete(id);
    }
  }

  async upsert(event: MarketEvent): Promise<{ created: boolean; event: MarketEvent }> {
    this.prune();
    const existing = this.events.get(event.id);
    if (!existing) {
      this.events.set(event.id, event);
      return { created: true, event };
    }

    // Merge rather than replace: a later cycle may carry additional documents
    // for the same event, and losing the earlier ones would erase corroboration.
    const merged: MarketEvent = {
      ...event,
      documentIds: [...new Set([...existing.documentIds, ...event.documentIds])],
      sources: [...new Set([...existing.sources, ...event.sources])],
      firstSeenAt:
        Date.parse(existing.firstSeenAt) <= Date.parse(event.firstSeenAt)
          ? existing.firstSeenAt
          : event.firstSeenAt,
    };
    this.events.set(event.id, merged);
    return { created: false, event: merged };
  }

  async get(id: string): Promise<MarketEvent | undefined> {
    return this.events.get(id);
  }

  async recent(options: { since?: Date; limit?: number } = {}): Promise<MarketEvent[]> {
    this.prune();
    let events = [...this.events.values()];
    if (options.since) {
      const sinceMs = options.since.getTime();
      events = events.filter((event) => Date.parse(event.lastUpdatedAt) >= sinceMs);
    }
    events.sort((a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt));
    return options.limit ? events.slice(0, options.limit) : events;
  }

  async size(): Promise<number> {
    this.prune();
    return this.events.size;
  }
}
