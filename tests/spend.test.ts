import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import { SpendBudget } from '../src/monitoring/spend.js';

/**
 * The ceiling that makes running this unattended defensible.
 *
 * Every property here is about refusing to overstate: not counting an unknown
 * cost as zero spending it never noticed, not clamping away an overshoot, and
 * not announcing the same halt every minute for a day.
 */

function at(iso: string) {
  return FixedClock.at(iso);
}

describe('no ceiling configured', () => {
  it('never blocks, which is what the system did before this existed', () => {
    const budget = new SpendBudget(0, at('2026-08-31T00:00:00Z'));
    expect(budget.enforced).toBe(false);
    budget.record(1000);
    expect(budget.exhausted).toBe(false);
    // Still counted, so the dashboard can show a spend even with no limit.
    expect(budget.spentUsd).toBe(1000);
  });

  it('treats a negative limit as no ceiling rather than an instant halt', () => {
    const budget = new SpendBudget(-5, at('2026-08-31T00:00:00Z'));
    expect(budget.enforced).toBe(false);
    expect(budget.exhausted).toBe(false);
  });
});

describe('a ceiling that is enforced', () => {
  it('stops once the day is spent', () => {
    const budget = new SpendBudget(1, at('2026-08-31T00:00:00Z'));
    budget.record(0.4);
    expect(budget.exhausted).toBe(false);
    budget.record(0.7);
    expect(budget.exhausted).toBe(true);
  });

  it('reports the overshoot rather than clamping it away', () => {
    // A call is billed after it returns, so the last one of the day can always
    // cross the line. Hiding by how much would make the number a comfort
    // rather than a measurement.
    const budget = new SpendBudget(1, at('2026-08-31T00:00:00Z'));
    budget.record(1.75);
    expect(budget.spentUsd).toBe(1.75);
    expect(budget.remainingUsd).toBeCloseTo(-0.75, 6);
  });

  it('does not count an unknown cost as free spending', () => {
    // undefined means the provider publishes no pricing for this model, not
    // that the call was free. It is recorded as zero because inventing a
    // number would make the whole budget a fiction.
    const budget = new SpendBudget(1, at('2026-08-31T00:00:00Z'));
    budget.record(undefined);
    budget.record(Number.NaN);
    budget.record(-3);
    expect(budget.spentUsd).toBe(0);
  });
});

describe('the rolling window', () => {
  it('resets after 24 hours and lets analysis resume', () => {
    const clock = at('2026-08-31T09:00:00Z');
    const budget = new SpendBudget(1, clock);
    budget.record(2);
    expect(budget.exhausted).toBe(true);

    clock.advance(23 * 3_600_000);
    expect(budget.exhausted).toBe(true);

    clock.advance(2 * 3_600_000);
    expect(budget.exhausted).toBe(false);
    expect(budget.spentUsd).toBe(0);
  });
});

describe('announcing the halt', () => {
  it('announces once, not every cycle', () => {
    // A Discord channel that repeats itself every minute is a channel nobody
    // reads on the day it matters.
    const budget = new SpendBudget(1, at('2026-08-31T00:00:00Z'));
    budget.record(2);
    expect(budget.claimAnnouncement()).toBe(true);
    expect(budget.claimAnnouncement()).toBe(false);
    expect(budget.claimAnnouncement()).toBe(false);
  });

  it('says nothing while there is budget left', () => {
    const budget = new SpendBudget(1, at('2026-08-31T00:00:00Z'));
    budget.record(0.1);
    expect(budget.claimAnnouncement()).toBe(false);
  });

  it('announces again the next day', () => {
    const clock = at('2026-08-31T09:00:00Z');
    const budget = new SpendBudget(1, clock);
    budget.record(2);
    expect(budget.claimAnnouncement()).toBe(true);

    clock.advance(25 * 3_600_000);
    budget.record(2);
    expect(budget.claimAnnouncement()).toBe(true);
  });
});
