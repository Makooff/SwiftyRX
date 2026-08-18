import { describe, expect, it } from 'vitest';
import {
  benjaminiHochberg,
  incompleteBeta,
  studentTTwoSidedP,
} from '../src/backtesting/stats.js';

/**
 * The statistics behind the study's threshold.
 *
 * These are checked against published table values rather than against
 * themselves, because a plausible-looking p-value is exactly the kind of error
 * that would quietly turn noise into findings.
 */

describe('Student t two-sided p-value', () => {
  // Critical values from any standard t table: p(t*, df) = 0.05.
  const criticalAtFivePercent: Array<[number, number]> = [
    [12.706, 1],
    [4.303, 2],
    [2.228, 10],
    [2.086, 20],
    [2.042, 30],
    [1.96, 1e7],
  ];

  it.each(criticalAtFivePercent)('gives 0.05 at t=%s on %s df', (t, df) => {
    expect(studentTTwoSidedP(t, df)).toBeCloseTo(0.05, 3);
  });

  it('matches published values away from the critical point', () => {
    expect(studentTTwoSidedP(2.0, 10)).toBeCloseTo(0.0734, 3);
    expect(studentTTwoSidedP(3.0, 39)).toBeCloseTo(0.0047, 3);
    expect(studentTTwoSidedP(1.0, 1)).toBeCloseTo(0.5, 3);
  });

  it('is symmetric in the sign of t', () => {
    expect(studentTTwoSidedP(-2.4, 30)).toBeCloseTo(studentTTwoSidedP(2.4, 30), 10);
  });

  it('is 1 at t=0 and falls monotonically as |t| grows', () => {
    expect(studentTTwoSidedP(0, 20)).toBe(1);
    const ps = [0.5, 1, 2, 3, 4].map((t) => studentTTwoSidedP(t, 20));
    expect([...ps].sort((a, b) => b - a)).toEqual(ps);
  });

  it('is more forgiving on few degrees of freedom than on many', () => {
    // The reason this uses the t-distribution at all: a standard error
    // clustered over 12 symbols has 11 degrees of freedom, and the normal
    // approximation would understate the p-value at exactly the threshold
    // where the call gets made.
    expect(studentTTwoSidedP(2.2, 11)).toBeGreaterThan(studentTTwoSidedP(2.2, 200));
  });

  it('refuses to answer on degenerate input rather than inventing a number', () => {
    expect(studentTTwoSidedP(Number.NaN, 20)).toBe(1);
    expect(studentTTwoSidedP(2, 0)).toBe(1);
  });
});

describe('incomplete beta', () => {
  it('is 0 and 1 at the ends', () => {
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
  });

  it('reduces to x for a=b=1, where the beta is uniform', () => {
    for (const x of [0.1, 0.35, 0.5, 0.9]) {
      expect(incompleteBeta(x, 1, 1)).toBeCloseTo(x, 6);
    }
  });

  it('is 0.5 at the midpoint of a symmetric beta', () => {
    expect(incompleteBeta(0.5, 4, 4)).toBeCloseTo(0.5, 6);
  });
});

describe('Benjamini-Hochberg control', () => {
  it('finds nothing in pure noise', () => {
    // 100 p-values spread uniformly, as nulls are. Every one of them would
    // have "crossed 0.05" under a per-test cutoff five times over.
    const nulls = Array.from({ length: 100 }, (_, i) => (i + 1) / 101);
    expect(benjaminiHochberg(nulls, 0.1).discoveries.size).toBe(0);
  });

  it('still finds a real effect buried among the nulls', () => {
    const nulls = Array.from({ length: 100 }, (_, i) => (i + 1) / 101);
    const result = benjaminiHochberg([0.0001, 0.0002, ...nulls], 0.1);
    expect(result.discoveries).toEqual(new Set([0, 1]));
  });

  it('rejects the exact shape the first full study run produced', () => {
    // Seven tests crossing |t|=1.96 out of 114, every t between 2.0 and 2.9.
    // Under a per-test cutoff those read as seven findings; ~6 are expected
    // from noise alone at that many tests.
    const borderline = [2.348, 2.872, 2.009, 2.432, 2.348, 2.27, 2.395].map((t) =>
      studentTTwoSidedP(t, 39),
    );
    const rest = Array.from({ length: 107 }, (_, i) => 0.06 + (i / 107) * 0.94);
    const result = benjaminiHochberg([...borderline, ...rest], 0.1);
    expect(result.discoveries.size).toBe(0);
  });

  it('steps up: a p-value failing its own rank threshold is carried by a later one', () => {
    // What separates BH from applying k/m·q test by test. With m=4 and q=0.1
    // the thresholds are 0.025, 0.05, 0.075, 0.1. Rank 2 (p=0.06) fails its
    // own — a per-test check would drop it — but rank 3 (p=0.07) clears 0.075,
    // and BH rejects everything up to the largest passing rank.
    const result = benjaminiHochberg([0.001, 0.06, 0.07, 0.5], 0.1);
    expect(result.discoveries).toEqual(new Set([0, 1, 2]));
    expect(result.cutoff).toBe(0.07);

    // With nothing clearing a later threshold, only rank 1 survives.
    expect(benjaminiHochberg([0.001, 0.06, 0.09, 0.5], 0.1).discoveries).toEqual(new Set([0]));
  });

  it('gets stricter as more tests are run', () => {
    const p = 0.02;
    expect(benjaminiHochberg([p, 0.9, 0.95], 0.1).discoveries.has(0)).toBe(true);
    const many = [p, ...Array.from({ length: 99 }, (_, i) => 0.3 + i / 200)];
    expect(benjaminiHochberg(many, 0.1).discoveries.has(0)).toBe(false);
  });

  it('reports how many hypotheses it weighed', () => {
    expect(benjaminiHochberg([0.01, 0.02, 0.9], 0.1).tests).toBe(3);
    expect(benjaminiHochberg([], 0.1).tests).toBe(0);
  });
});
