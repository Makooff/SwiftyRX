import { describe, expect, it } from 'vitest';
import {
  multiplicitySummary,
  runEventStudy,
  type StudyEvent,
} from '../src/backtesting/event-study.js';
import { studentTTwoSidedP } from '../src/backtesting/stats.js';
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
    // 40 events across 10 symbols on flat series: plenty of observations,
    // plenty of clusters, no effect.
    const flat = Array.from({ length: 60 }, () => 100);
    const symbols = Array.from({ length: 10 }, (_, i) => `SYM${i}`);
    const result = runEventStudy({
      events: symbols.flatMap((symbol) =>
        Array.from({ length: 4 }, (_, i) => event(symbol, i + 1)),
      ),
      barsBySymbol: new Map(symbols.map((symbol) => [symbol, bars(symbol, flat)])),
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

  it('refuses a finding built from too few distinct symbols', () => {
    // 60 filings from two companies is not 60 independent observations. Before
    // clustering, this was the exact shape that produced the largest
    // "significant" results in the real run.
    const drifting = Array.from({ length: 90 }, (_, i) => Number((100 * 1.004 ** i).toFixed(4)));
    const events = ['AAPL', 'MSFT'].flatMap((symbol) =>
      Array.from({ length: 30 }, (_, i) => event(symbol, i + 1)),
    );
    const result = runEventStudy({
      events,
      barsBySymbol: new Map([
        ['AAPL', bars('AAPL', drifting)],
        ['MSFT', bars('MSFT', drifting)],
      ]),
      horizons: [5],
    });

    expect(result[0]!.sampleSize).toBeGreaterThanOrEqual(30);
    expect(result[0]!.verdict).toMatch(/only 2 distinct symbol/);
  });

  it('reports the naive t-statistic too, and it is the inflated one', () => {
    // The shape this correction exists for: a handful of symbols on strong
    // multi-year drifts, each filing dozens of times. Every filing of one
    // company inherits that company's drift, so the 240 observations carry far
    // less information than 240 independent ones — but the naive statistic
    // counts them all. The naive number is kept visible because it is what the
    // previous version of this study reported.
    const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i}`);
    const barsBySymbol = new Map(
      symbols.map((symbol, s) => {
        // Per-symbol drift, plus an aperiodic wobble so returns genuinely vary.
        const drift = 1 + s * 0.0008;
        const closes = Array.from({ length: 90 }, (_, i) =>
          Number((100 * drift ** i * (1 + 0.01 * Math.sin(i * 1.7))).toFixed(4)),
        );
        return [symbol, bars(symbol, closes)] as const;
      }),
    );

    const result = runEventStudy({
      events: symbols.flatMap((symbol) =>
        Array.from({ length: 20 }, (_, i) => event(symbol, i + 1)),
      ),
      barsBySymbol: new Map(barsBySymbol),
      horizons: [5],
    });

    const horizon = result[0]!.horizons[0]!;
    expect(horizon.clusters).toBe(12);
    expect(horizon.sampleSize).toBe(240);
    expect(Math.abs(horizon.naiveTStat)).toBeGreaterThan(Math.abs(horizon.tStat));
  });

  it('counts how concentrated a sample is in its busiest symbol', () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const symbols = ['HEAVY', 'LIGHT'];
    const result = runEventStudy({
      events: [
        ...Array.from({ length: 30 }, (_, i) => event('HEAVY', i + 1)),
        ...Array.from({ length: 10 }, (_, i) => event('LIGHT', i + 1)),
      ],
      barsBySymbol: new Map(symbols.map((symbol) => [symbol, bars(symbol, flat)])),
      horizons: [1],
    });
    expect(result[0]!.horizons[0]!.largestClusterShare).toBeCloseTo(0.75, 2);
  });

  it('will not call an effect tradeable when it is smaller than the round trip', () => {
    // The distinction the whole project rests on: statistically real and worth
    // trading are different claims.
    const symbols = Array.from({ length: 15 }, (_, i) => `SYM${i}`);
    // +0.1% over the window, on a 0.3% round trip.
    const tiny = [100, 100, 100.1];
    const result = runEventStudy({
      events: symbols.map((symbol) => event(symbol, 1)),
      barsBySymbol: new Map(symbols.map((symbol) => [symbol, bars(symbol, tiny)])),
      horizons: [2],
      roundTripCostPct: 0.3,
    });

    const horizon = result[0]!.horizons[0]!;
    expect(horizon.meanAbnormalPct).toBeCloseTo(0.1, 3);
    expect(horizon.meanNetOfCostsPct).toBeCloseTo(-0.2, 3);
  });

  it('does not call a result a finding when it only stands up in isolation', () => {
    // The correction that turned the first full run's seven "findings" into
    // zero. One category with a modest real drift, unchanged in both runs — but
    // in the second it is one of forty-one tests, and a t of 2.67 is no longer
    // surprising among forty-one tries. Nothing about the effect changed; what
    // changed is how many other questions were asked alongside it.
    const real = Array.from({ length: 12 }, (_, i) => `REAL${i}`);
    const quiet = Array.from({ length: 12 }, (_, i) => `QUIET${i}`);

    const barsBySymbol = new Map<string, Bar[]>();
    real.forEach((symbol, s) => {
      barsBySymbol.set(
        symbol,
        bars(
          symbol,
          Array.from({ length: 90 }, (_, i) =>
            Number((100 * 1.0004 ** i * (1 + 0.02 * Math.sin(i * 1.7 + s))).toFixed(4)),
          ),
        ),
      );
    });
    // Flat: these categories are real tests that found nothing, which is what
    // most tests do and what the count is supposed to include.
    for (const symbol of quiet) {
      barsBySymbol.set(symbol, bars(symbol, Array.from({ length: 90 }, () => 100)));
    }

    const realEvents = real.flatMap((symbol) =>
      Array.from({ length: 4 }, (_, i) => event(symbol, i * 5 + 1, 'real')),
    );
    const quietEvents = Array.from({ length: 40 }, (_, c) =>
      quiet.flatMap((symbol) =>
        Array.from({ length: 4 }, (_, i) => event(symbol, i * 5 + 1, `quiet${c}`)),
      ),
    ).flat();

    const alone = runEventStudy({ events: realEvents, barsBySymbol, horizons: [5] });
    const amongMany = runEventStudy({
      events: [...realEvents, ...quietEvents],
      barsBySymbol,
      horizons: [5],
    });

    const findReal = (rs: typeof alone) => rs.find((r) => r.category === 'real')!.horizons[0]!;
    expect(findReal(alone).tStat).toBe(findReal(amongMany).tStat);
    expect(findReal(alone).survivesMultiplicity).toBe(true);
    expect(findReal(amongMany).survivesMultiplicity).toBe(false);

    // And it says which of the two it is, rather than falling back to the
    // wording used when a category showed nothing at all.
    expect(amongMany.find((r) => r.category === 'real')!.verdict).toMatch(
      /does not survive the number of tests/,
    );

    // The quiet forty are counted as tests, which is the whole mechanism.
    expect(multiplicitySummary(alone).tested).toBe(1);
    expect(multiplicitySummary(amongMany).tested).toBe(41);
    expect(multiplicitySummary(amongMany).nominal).toBe(1);
    expect(multiplicitySummary(amongMany).survivors).toBe(0);
  });

  it('attaches a p-value on the clusters, not on the observations', () => {
    // 240 observations from 12 symbols has 11 degrees of freedom, not 239.
    const symbols = Array.from({ length: 12 }, (_, i) => `SYM${i}`);
    const barsBySymbol = new Map(
      symbols.map((symbol, s) => {
        const closes = Array.from({ length: 90 }, (_, i) =>
          Number((100 * (1 + s * 0.0008) ** i * (1 + 0.01 * Math.sin(i * 1.7))).toFixed(4)),
        );
        return [symbol, bars(symbol, closes)] as const;
      }),
    );
    const result = runEventStudy({
      events: symbols.flatMap((symbol) =>
        Array.from({ length: 20 }, (_, i) => event(symbol, i + 1)),
      ),
      barsBySymbol,
      horizons: [5],
    });

    const h = result[0]!.horizons[0]!;
    expect(h.clusters).toBe(12);
    expect(h.pValue).toBeCloseTo(studentTTwoSidedP(h.tStat, 11), 5);
  });

  it('computes a naive t-statistic that grows with sample size, not with the mean alone', () => {
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
    expect(Math.abs(many[0]!.horizons[0]!.naiveTStat)).toBeGreaterThan(
      Math.abs(few[0]!.horizons[0]!.naiveTStat),
    );
    // All from one symbol, so the clustered statistic declines to say anything.
    expect(many[0]!.horizons[0]!.tStat).toBe(0);
  });
});
