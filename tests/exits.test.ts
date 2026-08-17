import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import { PositionManager, horizonDays } from '../src/risk/position-manager.js';
import type { Position } from '../src/risk/types.js';

/**
 * Exit rules.
 *
 * The property under test is the one that was previously false: a position
 * sized against a stop is a position that actually gets closed at that stop.
 * Without this, `MAX_SINGLE_TRADE_RISK_PERCENT` describes an event that never
 * happens.
 */

const clock = FixedClock.at('2026-08-18T12:00:00Z');

function position(symbol: string, quantity = 10, averagePrice = 100): Position {
  return {
    symbol,
    quantity,
    averagePrice,
    currency: 'EUR',
    marketValue: quantity * averagePrice,
    unrealisedPnl: 0,
    openedAt: '2026-08-18T11:00:00Z',
  };
}

function manager(rewardToRisk = 2) {
  return new PositionManager({ rewardToRisk, clock });
}

describe('exit planning', () => {
  it('places the target at the configured multiple of the stop distance', () => {
    const pm = manager(2);
    const plan = pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    expect(plan.stopPrice).toBe(95);
    // Risk 5, so target 10 above entry.
    expect(plan.takeProfitPrice).toBe(110);
  });

  it('derives the deadline from the signal horizon', () => {
    const pm = manager();
    const short = pm.track({ symbol: 'A', entryPrice: 100, stopPrice: 95, horizon: 'intraday', signalId: 's' });
    const long = pm.track({ symbol: 'B', entryPrice: 100, stopPrice: 95, horizon: '1-4w', signalId: 's' });
    expect(short.expiresAt.slice(0, 10)).toBe('2026-08-19');
    expect(long.expiresAt.slice(0, 10)).toBe('2026-09-15');
  });

  it('gives an unclear horizon a deadline rather than an open-ended hold', () => {
    // A thesis with no stated horizon is not a thesis with an infinite one.
    expect(horizonDays('unclear')).toBe(5);
    expect(horizonDays(undefined)).toBe(5);
    expect(horizonDays('nonsense-label')).toBe(5);
  });
});

describe('exits due', () => {
  it('closes at the stop', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    const exits = pm.exitsDue([position('AAPL')], new Map([['AAPL', 94.5]]));
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).toBe('stop_loss');
    expect(exits[0]!.pnlPercent).toBeLessThan(0);
  });

  it('closes at the target', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    const exits = pm.exitsDue([position('AAPL')], new Map([['AAPL', 111]]));
    expect(exits[0]!.reason).toBe('take_profit');
  });

  it('prefers the stop when both could be argued', () => {
    // Only reachable on a wide move, but when a single price could justify
    // either reading, the loss is the one that matters.
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    const exits = pm.exitsDue([position('AAPL')], new Map([['AAPL', 90]]));
    expect(exits[0]!.reason).toBe('stop_loss');
  });

  it('holds while the price sits between stop and target', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    expect(pm.exitsDue([position('AAPL')], new Map([['AAPL', 103]]))).toHaveLength(0);
  });

  it('closes once the horizon has passed, even at a profit', () => {
    const past = new PositionManager({ clock: FixedClock.at('2026-08-01T12:00:00Z') });
    past.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, horizon: '1-5d', signalId: 's1' });

    // Same plans, read by a clock two weeks later.
    const later = new PositionManager({ clock });
    later.restore(past.serialize());

    const exits = later.exitsDue([position('AAPL')], new Map([['AAPL', 104]]));
    expect(exits[0]!.reason).toBe('horizon');
    expect(exits[0]!.pnlPercent).toBeGreaterThan(0);
  });

  it('ignores positions it has no plan for', () => {
    const pm = manager();
    expect(pm.exitsDue([position('AAPL')], new Map([['AAPL', 10]]))).toHaveLength(0);
  });

  it('does not invent an exit when the price is unknown', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    expect(pm.exitsDue([position('AAPL')], new Map())).toHaveLength(0);
  });

  it('reports an unpriceable position instead of treating it as safe', () => {
    // A position whose price is unknown is a position whose stop cannot be
    // checked. Silence there would hide exactly the failure that matters.
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    expect(pm.unpriceable([position('AAPL')], new Map())).toEqual(['AAPL']);
    expect(pm.unpriceable([position('AAPL')], new Map([['AAPL', 99]]))).toEqual([]);
  });

  it('forgets a plan once the position is closed', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });
    pm.forget('AAPL');
    expect(pm.exitsDue([position('AAPL')], new Map([['AAPL', 1]]))).toHaveLength(0);
  });
});

describe('adoption', () => {
  it('gives an untracked position a plan rather than leaving it unmanaged', () => {
    // Reachable after restoring state written before exits existed. Leaving it
    // alone would silently recreate the hole this module closes.
    const pm = manager();
    pm.adoptIfUntracked(position('AAPL', 10, 200), 5);
    const plan = pm.get('AAPL');
    expect(plan?.stopPrice).toBe(190);
    expect(plan?.signalId).toBe('adopted');
  });

  it('never overwrites an existing plan', () => {
    const pm = manager();
    pm.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 'real' });
    pm.adoptIfUntracked(position('AAPL'), 20);
    expect(pm.get('AAPL')?.signalId).toBe('real');
  });
});

describe('persistence', () => {
  it('survives a restart, so stops are not forgotten', () => {
    const before = manager();
    before.track({ symbol: 'AAPL', entryPrice: 100, stopPrice: 95, signalId: 's1' });

    const after = manager();
    after.restore(before.serialize());

    expect(after.exitsDue([position('AAPL')], new Map([['AAPL', 94]]))[0]?.reason).toBe('stop_loss');
  });
});
