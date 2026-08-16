import { type Clock, systemClock } from './clock.js';
import { CircuitOpenError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe request. */
  resetTimeoutMs?: number;
  /** Successful probes required to close the circuit again. */
  successThreshold?: number;
}

/**
 * Per-provider circuit breaker.
 *
 * When a data source starts failing we stop hammering it and — more
 * importantly — the rest of the system learns the source is unavailable, which
 * feeds the "critical data missing -> DO NOT TRADE" rule.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAtMs = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;

  constructor(
    public readonly name: string,
    options: CircuitBreakerOptions = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 60_000;
    this.successThreshold = options.successThreshold ?? 2;
  }

  get currentState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && this.clock.nowMs() - this.openedAtMs >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.successes = 0;
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === 'open') {
      throw new CircuitOpenError(`Circuit "${this.name}" is open`, {
        provider: this.name,
        retryInMs: this.resetTimeoutMs - (this.clock.nowMs() - this.openedAtMs),
      });
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
      }
      return;
    }
    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAtMs = this.clock.nowMs();
    this.successes = 0;
  }

  /** Test/ops helper. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
  }
}
