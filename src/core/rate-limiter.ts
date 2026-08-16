import { type Clock, systemClock } from './clock.js';

/**
 * Token-bucket rate limiter.
 *
 * Each provider adapter owns one, configured from that provider's *published*
 * limit (see docs/API_RESEARCH.md). We stay under the documented ceiling
 * rather than discovering it by getting banned.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (capacity <= 0) throw new Error('TokenBucket capacity must be > 0');
    if (refillPerSecond <= 0) throw new Error('TokenBucket refillPerSecond must be > 0');
    this.tokens = capacity;
    this.lastRefillMs = clock.nowMs();
  }

  /** Build from a "N requests per minute" published limit. */
  static perMinute(requests: number, clock: Clock = systemClock): TokenBucket {
    return new TokenBucket(Math.max(1, requests), requests / 60, clock);
  }

  /** Build from a "N requests per day" published limit. */
  static perDay(requests: number, clock: Clock = systemClock): TokenBucket {
    return new TokenBucket(Math.max(1, requests), requests / 86_400, clock);
  }

  private refill(): void {
    const now = this.clock.nowMs();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = now;
  }

  /** Try to consume a token without waiting. */
  tryAcquire(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Milliseconds until `cost` tokens become available. */
  waitTimeMs(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Wait until a token is available, then consume it. */
  async acquire(cost = 1): Promise<void> {
    // Loop rather than sleep-once: other callers may take the token first.
    for (;;) {
      if (this.tryAcquire(cost)) return;
      await this.clock.sleep(Math.max(1, this.waitTimeMs(cost)));
    }
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Hard daily counter for *metered* (billed-per-call) APIs such as X.
 *
 * A token bucket smooths traffic; this refuses outright once the configured
 * daily budget is spent, so a runaway loop cannot generate an unbounded bill.
 */
export class DailyQuota {
  private used = 0;
  private windowStartMs: number;

  constructor(
    public readonly limit: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.windowStartMs = clock.nowMs();
  }

  private roll(): void {
    const now = this.clock.nowMs();
    if (now - this.windowStartMs >= 86_400_000) {
      this.used = 0;
      this.windowStartMs = now;
    }
  }

  canSpend(units = 1): boolean {
    this.roll();
    return this.used + units <= this.limit;
  }

  spend(units = 1): void {
    this.roll();
    this.used += units;
  }

  get remaining(): number {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }
}
