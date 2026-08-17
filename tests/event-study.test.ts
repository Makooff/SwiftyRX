import { describe, expect, it } from 'vitest';
import { runEventStudy, type StudyEvent } from '../src/backtesting/event-study.js';
import type { Bar } from '../src/domain/types.js';

/**
 * Event study.
 *
 * The properties that matter are the ones that stop a study flattering itself:
 * entry after the event, benchmark subtracted, and a refusal to call anything a
 * finding on a small sample.
 */

function bars(symbol: string, closes: number[], startDay = 1): Bar[] {
  return closes.map((close, i) => {
    const timestamp = new Date(Date.UTC(2026, 0, startDay + i)).toISOString();
    return {
      symbol,
      timestamp,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000_000,
      interval: '1Day' as const,
      freshness: { asOf: timestamp, retrievedAt: timestamp, delayClass: 'end_of_day' as const, feed: 'test' },
    };
  });
}

function event(symbol: string, day: number, category = 'earnings'): StudyEvent {
  return { symbol, at: new Date(Date.UTC(2026, 0, day, 21, 0)).toISOString(), category };
}

describe('event study', () => {
  it('enters at the next session, never the one the event landed on', () => {
    // A filing at 21:00 UTC cannot be traded at that day's close. Pretending
    // otherwise is the standard way an event study invents an edge.
    const flat = [100, 100, 110, 110, 110, 110];
    const result = runEventStudy({
      events: [event('AAPL', 2)],
      barsBySymbol: new Map([['AAPL', bars('AAPL', flat)]]),
      horizons: [1],
    });

    // Entry is day 3's open (110), exit day 3's close (110) → 0%, not the
    // +10% a same-day entry would have booked.
    expect(result[0]!.horizons[0]!.meanAbnormalPct).toBe(0);
  });

  it('subtracts the benchmark, so a bull market is not mistaken for an edge', () => {
    // Stock and market both rise 10%. The abnormal return is zero.
    const rising = [100, 100, 110];
    const result = runEventStudy({
      events: [event('AAPL', 1)],
      barsBySymbol: new Map([['AAPL', bars('AAPL', rising)]]),
      benchmarkBars: bars('SPY', rising),
      horizons: [2],
    });
    expect(result[0]!.horizons[0]!.meanAbnormalPct).toBe(0);
  });

  it('reports genuine outperformance once the market is stripped out', () => {
    const stock = [100, 100, 120];
    const market = [100, 100, 110];
    const result = runEventStudy({
      events: [event('AAPL', 1)],
      barsBySymbol: new Map([['AAPL', bars('AAPL', stock)]]),
      benchmarkBars: bars('SPY', market),
      horizons: [2],
    });
    expect(result[0]!.horizons[0]!.meanAbnormalPct).toBeCloseTo(10, 1);
  });

  it('refuses to call a small sample a finding, however large the mean', () => {
    const explosive = [100, 100, 200];
    const result = runEventStudy({
      events: [event('AAPL', 1)],
      barsBySymbol: new Map([['AAPL', bars('AAPL', explosive)]]),
      horizons: [2],
    });
    expect(result[0]!.horizons[0]!.meanAbnormalPct).toBeCloseTo(100, 0);
    expect(result[0]!.verdict).toMatch(/too few to conclude/);
  });

  it('says "no abnormal drift" when a large sample shows nothing', () => {
    // 40 events on a flat series: plenty of observations, no effect.
    const flat = Array.from({ length: 60 }, () => 100);
    const events = Array.from({ length: 40 }, (_, i) => event('AAPL', i + 1));
    const result = runEventStudy({
      events,
      barsBySymbol: new Map([['AAPL', bars('AAPL', flat)]]),
      horizons: [1],
    });
    expect(result[0]!.sampleSize).toBeGreaterThanOrEqual(30);
    expect(result[0]!.verdict).toMatch(/no abnormal drift/);
  });

  it('drops events whose window runs past the data', () => {
    // A truncated window would bias the result toward whatever the last bars
    // happened to do.
    const short = [100, 100, 100];
    const result = runEventStudy({
      events: [event('AAPL', 1)],
      barsBySymbol: new Map([['AAPL', bars('AAPL', short)]]),
      horizons: [20],
    });
    expect(result[0]?.horizons[0]?.sampleSize ?? 0).toBe(0);
  });

  it('separates categories rather than pooling them', () => {
    const flat = Array.from({ length: 30 }, () => 100);
    const result = runEventStudy({
      events: [event('AAPL', 1, 'earnings'), event('AAPL', 2, 'm_and_a')],
      barsBySymbol: new Map([['AAPL', bars('AAPL', flat)]]),
      horizons: [1],
    });
    expect(result.map((r) => r.category).sort()).toEqual(['earnings', 'm_and_a']);
  });

  it('ignores events for symbols it has no bars for', () => {
    const result = runEventStudy({
      events: [event('UNKNOWN', 1)],
      barsBySymbol: new Map(),
      horizons: [1],
    });
    expect(result).toHaveLength(0);
  });

  it('computes a t-statistic that grows with sample size, not with the mean alone', () => {
    // Same effect, more observations → more confidence. This is the number that
    // separates a result from an anecdote.
    //
    // The series needs real dispersion, and it must be aperiodic: a period-2
    // wobble sampled every 2 days yields identical ratios and a variance of
    // zero, which would let this pass against a broken implementation. A drift
    // plus a sine of irrational-ish period gives varied returns around a
    // consistent mean, deterministically.
    const drifting = Array.from({ length: 120 }, (_, i) =>
      Number((100 * 1.002 ** i * (1 + 0.01 * Math.sin(i * 1.7))).toFixed(4)),
    );
    const barsFor = bars('AAPL', drifting);

    const few = runEventStudy({
      events: Array.from({ length: 5 }, (_, i) => event('AAPL', i * 2 + 1)),
      barsBySymbol: new Map([['AAPL', barsFor]]),
      horizons: [2],
    });
    const many = runEventStudy({
      events: Array.from({ length: 40 }, (_, i) => event('AAPL', i * 2 + 1)),
      barsBySymbol: new Map([['AAPL', barsFor]]),
      horizons: [2],
    });

    expect(few[0]!.horizons[0]!.stdDevPct).toBeGreaterThan(0);
    expect(Math.abs(many[0]!.horizons[0]!.tStat)).toBeGreaterThan(
      Math.abs(few[0]!.horizons[0]!.tStat),
    );
  });
});
