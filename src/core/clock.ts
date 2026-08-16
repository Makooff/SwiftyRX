/**
 * Injectable clock.
 *
 * Every timestamp in the system flows through a Clock so that backtests and
 * tests can control "now". A backtest that reads the wall clock is a
 * look-ahead bug waiting to happen.
 */
export interface Clock {
  now(): Date;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Deterministic clock for tests and backtesting. */
export class FixedClock implements Clock {
  constructor(private current: number) {}

  static at(iso: string): FixedClock {
    return new FixedClock(new Date(iso).getTime());
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  /** Advancing is explicit: sleeping never blocks a test. */
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(iso: string): void {
    this.current = new Date(iso).getTime();
  }
}

export function ageSeconds(timestamp: Date | string, clock: Clock = systemClock): number {
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp.getTime();
  return (clock.nowMs() - ms) / 1000;
}
