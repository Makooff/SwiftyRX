import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TradingAgent } from '../apps/worker/agent.js';
import { loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import type { Bar } from '../src/domain/types.js';
import { Portfolio } from '../src/execution/paper/portfolio.js';
import { RiskEngine } from '../src/risk/engine.js';
import {
  CorrelationGroups,
  alignedReturns,
  estimateGroups,
  pearson,
  writeCorrelationFile,
} from '../src/risk/correlation.js';

/**
 * Correlation groups.
 *
 * The limit they feed — MAX_CORRELATED_EXPOSURE_PERCENT — was configured,
 * printed by config:check, shown on the dashboard, and applied to nothing,
 * because the Risk Engine skips the check when an order carries no group and
 * nothing ever set one. These tests pin the estimation and, more importantly,
 * that a group now actually reaches the engine.
 */

const clock = FixedClock.at('2026-08-18T12:00:00Z');

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
      freshness: {
        asOf: timestamp,
        retrievedAt: timestamp,
        delayClass: 'end_of_day' as const,
        feed: 'test',
      },
    };
  });
}

/** A deterministic wiggle, so series have variance without being random. */
function wiggle(length: number, amplitude = 0.02, phase = 0): number[] {
  return Array.from({ length }, (_, i) => 100 * (1 + amplitude * Math.sin(i * 1.7 + phase)));
}

/**
 * A deterministic pseudo-random walk, for the "uncorrelated" side.
 *
 * Not a phase-shifted sine: two sinusoids of the same frequency correlate at
 * cos(phase), so a shifted `wiggle` is strongly correlated with the original
 * and would test the fixture rather than the grouping.
 */
function walk(length: number, seed: number): number[] {
  let state = seed;
  const closes = [100];
  for (let i = 1; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    closes.push(closes[i - 1]! * (1 + (state / 2147483648 - 0.5) * 0.04));
  }
  return closes;
}

describe('pearson', () => {
  it('is 1 for a series against itself and -1 against its mirror', () => {
    const a = [0.01, -0.02, 0.03, -0.01, 0.02];
    expect(pearson(a, a)).toBeCloseTo(1);
    expect(pearson(a, a.map((x) => -x))).toBeCloseTo(-1);
  });

  it('is near zero for series that do not move together', () => {
    const a = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
    const b = [0.01, 0.01, -0.01, -0.01, 0.01, 0.01];
    expect(Math.abs(pearson(a, b)!)).toBeLessThan(0.5);
  });

  it('has no answer when a series never moved', () => {
    // A flat series has no defined correlation with anything, and returning 0
    // would quietly claim it is uncorrelated rather than unmeasured.
    expect(pearson([0, 0, 0, 0], [0.01, -0.02, 0.03, 0.01])).toBeUndefined();
  });

  it('has no answer on mismatched or too-short input', () => {
    expect(pearson([0.01], [0.01])).toBeUndefined();
    expect(pearson([0.01, 0.02], [0.01])).toBeUndefined();
  });
});

describe('aligning returns', () => {
  it('uses only the sessions both symbols actually traded', () => {
    // B is missing the second session. Aligning by index would pair B's third
    // close with A's second and measure something that is not correlation.
    const a = bars('A', [100, 110, 120, 130]);
    const b = [bars('B', [100])[0]!, ...bars('B', [120, 130], 3)];
    const { a: ra, b: rb } = alignedReturns(a, b);
    expect(ra).toHaveLength(rb.length);
    // Shared sessions are days 1, 3, 4 → two returns.
    expect(ra).toHaveLength(2);
  });

  it('drops a pair around a non-positive close rather than one side of it', () => {
    const a = bars('A', [100, 0, 120, 130]);
    const b = bars('B', [100, 105, 110, 115]);
    const { a: ra, b: rb } = alignedReturns(a, b);
    expect(ra).toHaveLength(rb.length);
  });

  it('returns nothing when the two never overlap', () => {
    const { a, b } = alignedReturns(bars('A', [100, 110], 1), bars('B', [100, 110], 50));
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});

describe('estimating groups', () => {
  const LENGTH = 80;

  it('joins symbols that move together and separates one that does not', () => {
    const together = wiggle(LENGTH);
    const groups = estimateGroups(
      new Map([
        ['AAA', bars('AAA', together)],
        ['BBB', bars('BBB', together.map((c) => c * 1.5))],
        ['ZZZ', bars('ZZZ', walk(LENGTH, 7))],
      ]),
      { minObservations: 30 },
    );

    expect(groups.AAA).toBe(groups.BBB);
    expect(groups.ZZZ).not.toBe(groups.AAA);
  });

  it('joins symbols that move hard in opposite directions', () => {
    // Two names that mirror each other are one bet expressed twice, not a
    // diversified pair — so the grouping is on |r|, not r.
    const up = wiggle(LENGTH);
    const groups = estimateGroups(
      new Map([
        ['AAA', bars('AAA', up)],
        ['BBB', bars('BBB', up.map((c) => 200 - c))],
      ]),
      { minObservations: 30 },
    );
    expect(groups.AAA).toBe(groups.BBB);
  });

  it('gives every symbol a group, including one correlated with nothing', () => {
    // An ungrouped symbol is one the exposure limit skips, which is the state
    // this whole feature exists to end.
    const groups = estimateGroups(
      new Map([
        ['AAA', bars('AAA', wiggle(LENGTH))],
        ['ZZZ', bars('ZZZ', walk(LENGTH, 7))],
      ]),
      { minObservations: 30 },
    );
    expect(Object.keys(groups).sort()).toEqual(['AAA', 'ZZZ']);
    expect(groups.ZZZ).toBe('ZZZ');
  });

  it('refuses to group a pair with too few shared sessions', () => {
    const together = wiggle(20);
    const groups = estimateGroups(
      new Map([
        ['AAA', bars('AAA', together)],
        ['BBB', bars('BBB', together.map((c) => c * 1.5))],
      ]),
      { minObservations: 60 },
    );
    expect(groups.AAA).not.toBe(groups.BBB);
  });

  it('labels a group deterministically, so the file diffs meaningfully', () => {
    const together = wiggle(LENGTH);
    const build = () =>
      estimateGroups(
        new Map([
          ['MMM', bars('MMM', together)],
          ['AAA', bars('AAA', together.map((c) => c * 1.5))],
        ]),
        { minObservations: 30 },
      );
    expect(build()).toEqual(build());
    // Alphabetically first member names the group.
    expect(build().MMM).toBe('AAA');
  });
});

describe('the groups as the agent reads them', () => {
  const file = {
    generatedAt: '2026-08-18T00:00:00Z',
    windowDays: 365,
    threshold: 0.7,
    minObservations: 60,
    groups: { AAPL: 'AAPL', MSFT: 'AAPL', JPM: 'JPM' },
  };

  it('reports the group for a symbol, case-insensitively', () => {
    const book = CorrelationGroups.fromFile(file);
    expect(book.groupFor('MSFT')).toBe('AAPL');
    expect(book.groupFor('msft')).toBe('AAPL');
  });

  it('has no opinion on a symbol the estimate never saw', () => {
    // Deliberately undefined rather than the symbol itself: unconstrained must
    // be distinguishable from a group of one.
    expect(CorrelationGroups.fromFile(file).groupFor('TSLA')).toBeUndefined();
  });

  it('lists clusters largest first', () => {
    expect(CorrelationGroups.fromFile(file).clusters[0]).toEqual({
      group: 'AAPL',
      symbols: ['AAPL', 'MSFT'],
    });
  });

  it('has no opinion at all when no file exists', () => {
    expect(CorrelationGroups.load(join(tmpdir(), 'no-such-correlations.json'))).toBeUndefined();
  });

  it('treats a corrupt file as no groups rather than as permission', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'corr-')), 'groups.json');
    writeFileSync(path, '{ not json', 'utf8');
    expect(CorrelationGroups.load(path)).toBeUndefined();
  });

  it('round-trips through disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'corr-')), 'nested', 'groups.json');
    writeCorrelationFile(path, file);
    expect(CorrelationGroups.load(path)?.groupFor('MSFT')).toBe('AAPL');
  });
});

describe('the portfolio snapshot the risk engine reads', () => {
  it('labels held positions with their group', () => {
    const portfolio = new Portfolio({
      initialCash: 10_000,
      clock,
      correlationGroupFor: (symbol) => (symbol === 'NVDA' ? 'semis' : undefined),
    });
    portfolio.applyBuy('NVDA', 5, 200, 1);

    expect(portfolio.snapshot().positions[0]!.correlationGroup).toBe('semis');
  });

  it('labels a position restored from a state file written before groups existed', () => {
    // The reason the group is resolved on read rather than stored: a position
    // opened before any correlation run would otherwise stay ungrouped
    // forever, and ungrouped is exactly where the limit does nothing.
    const original = new Portfolio({ initialCash: 10_000, clock });
    original.applyBuy('NVDA', 5, 200, 1);
    expect(original.snapshot().positions[0]!.correlationGroup).toBeUndefined();

    const restored = Portfolio.restore(original.serialize(), {
      clock,
      correlationGroupFor: () => 'semis',
    });
    expect(restored.snapshot().positions[0]!.correlationGroup).toBe('semis');
  });

  it('leaves a position unlabelled when nothing knows its group', () => {
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    portfolio.applyBuy('NVDA', 5, 200, 1);
    expect(portfolio.snapshot().positions[0]!.correlationGroup).toBeUndefined();
  });
});

describe('the limit actually applying', () => {
  /**
   * The point of the whole feature. `max_correlated_exposure` is guarded by
   * `if (request.correlationGroup)`, so with no group the rule does not merely
   * pass — it never runs, and does not appear among the checks at all. That is
   * what every order did before this existed.
   */
  function engineWith(groups: Record<string, string> | undefined) {
    const book = groups
      ? CorrelationGroups.fromFile({
          generatedAt: '2026-08-18T00:00:00Z',
          windowDays: 365,
          threshold: 0.7,
          minObservations: 60,
          groups,
        })
      : undefined;
    const groupFor = (symbol: string) => book?.groupFor(symbol);

    const portfolio = new Portfolio({
      initialCash: 10_000,
      clock,
      correlationGroupFor: groupFor,
    });
    portfolio.applyBuy('NVDA', 20, 200, 1);

    // 30%, chosen so one position alone clears it and two together do not:
    // at 10% the 20%-of-portfolio sizing breaches the limit on its own, which
    // would make both cases fail for a reason unrelated to grouping.
    const engine = new RiskEngine({
      config: loadConfig({ MAX_CORRELATED_EXPOSURE_PERCENT: '30' }),
      clock,
    });

    const group = groupFor('AMD');
    return engine.evaluate(
      {
        symbol: 'AMD',
        action: 'BUY',
        score: 0.8,
        price: 200,
        priceAgeSeconds: 5,
        volatilityPct: 25,
        ...(group ? { correlationGroup: group } : {}),
        clientOrderId: 'order-correlation-test',
      },
      portfolio.snapshot(),
    );
  }

  it('never even runs the check when no groups are known', () => {
    const decision = engineWith(undefined);
    expect(decision.checks.map((c) => c.rule)).not.toContain('max_correlated_exposure');
  });

  it('refuses a second name in the same estimated group', () => {
    const decision = engineWith({ NVDA: 'NVDA', AMD: 'NVDA' });
    expect(decision.checks.map((c) => c.rule)).toContain('max_correlated_exposure');
    expect(decision.rejections.map((r) => r.rule)).toContain('max_correlated_exposure');
  });

  it('allows a name the estimate put in a different group', () => {
    const decision = engineWith({ NVDA: 'NVDA', AMD: 'AMD' });
    expect(decision.checks.find((c) => c.rule === 'max_correlated_exposure')?.passed).toBe(true);
    expect(decision.rejections.map((r) => r.rule)).not.toContain('max_correlated_exposure');
  });

  it('picks up a file written by the correlations script, through config', () => {
    // The seam between `npm run correlations -- --out` and the running agent:
    // a file on disk at CORRELATION_FILE, loaded at construction.
    const path = join(mkdtempSync(join(tmpdir(), 'corr-agent-')), 'groups.json');
    writeCorrelationFile(path, {
      generatedAt: '2026-08-18T00:00:00Z',
      windowDays: 365,
      threshold: 0.7,
      minObservations: 60,
      groups: { NVDA: 'NVDA', AMD: 'NVDA' },
    });

    const agent = new TradingAgent({
      config: loadConfig({ CORRELATION_FILE: path, EVIDENCE_FILE: join(tmpdir(), 'none.json') }),
      clock,
    });

    expect(agent.correlationSource()).toBe('estimated');
    expect(agent.correlationGroupFor('AMD')).toBe('NVDA');
  });

  it('falls back to the curated sector map when no estimate exists', () => {
    const agent = new TradingAgent({
      config: loadConfig({
        CORRELATION_FILE: join(tmpdir(), 'no-such-correlations.json'),
        EVIDENCE_FILE: join(tmpdir(), 'none.json'),
      }),
      clock,
    });

    expect(agent.correlationSource()).toBe('sector_map');
    // NVDA and AMD are both semiconductors in the curated registry, so the
    // limit applies to them even before any correlation run.
    expect(agent.correlationGroupFor('NVDA')).toBe('semiconductors');
    expect(agent.correlationGroupFor('AMD')).toBe('semiconductors');
    // ...and says nothing about a company the registry has never heard of.
    expect(agent.correlationGroupFor('ZZZZ')).toBeUndefined();
  });
});
