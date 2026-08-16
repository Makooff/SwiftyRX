import { type Clock, systemClock } from './clock.js';

/**
 * Minimal cache contract. The in-memory implementation is enough for Phase 1;
 * a Redis-backed implementation can be dropped in later without touching
 * adapters.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAtMs: number;
}

export class MemoryCache implements Cache {
  private readonly store = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxEntries = 10_000,
  ) {}

  private evictIfNeeded(): void {
    if (this.store.size <= this.maxEntries) return;
    // Map preserves insertion order: drop the oldest entries first.
    const excess = this.store.size - this.maxEntries;
    let dropped = 0;
    for (const key of this.store.keys()) {
      this.store.delete(key);
      if (++dropped >= excess) break;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock.nowMs()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.clock.nowMs() + ttlSeconds * 1000 });
    this.evictIfNeeded();
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}
