import { type Clock, systemClock } from '../core/clock.js';
import type { Position } from './types.js';

/**
 * Exit rules for open positions.
 *
 * This closes a hole that made one of the system's central claims false.
 * `sizePosition` computes a stop price and sizes the trade so that hitting it
 * costs at most `MAX_SINGLE_TRADE_RISK_PERCENT` of the portfolio — but nothing
 * enforced that stop. A position opened on an earnings beat simply stayed open.
 *
 * Without an enforced exit, "1% risk per trade" is arithmetic about an event
 * that never happens: the real exposure is the whole position, up to the
 * position cap. Sizing against a stop you do not honour is worse than not
 * sizing at all, because it produces a number that reads like safety.
 *
 * Three exits, in priority order:
 *
 *  1. **Stop loss** — the thesis is wrong, or the market disagrees enough that
 *     waiting costs more than being right later is worth.
 *  2. **Take profit** — a multiple of the stop distance. This is a convention,
 *     not a finding: it makes the risk/reward explicit rather than leaving the
 *     upside undefined, and it is configurable precisely because no evidence
 *     here supports one multiple over another.
 *  3. **Horizon** — every signal states how long its thesis should take. Past
 *     that, the reason for holding has expired even if the price has not moved.
 *     Holding on afterwards is a new decision nobody made.
 *
 * ## What a stop here is, and is not
 *
 * These are evaluated against our own marks once per cycle. They are **not**
 * resting orders at the broker. Two consequences that must not be glossed:
 *
 *  - A gap through the stop fills at the next available price, not at the stop.
 *    The loss can exceed the risk budget. The budget bounds the *intended*
 *    risk, never the realised one.
 *  - Between cycles, nothing is watching. With a 60-second cycle that is a
 *    60-second blind spot.
 *
 * Resting stop orders at the broker would fix both, and are the right upgrade
 * before real money.
 */

export type ExitReason = 'stop_loss' | 'take_profit' | 'horizon' | 'thesis_invalidated';

export interface ManagedPosition {
  symbol: string;
  /** Price at which the risk engine sized the trade. */
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  /** After this instant the thesis has expired regardless of price. */
  expiresAt: string;
  openedAt: string;
  /** The signal that opened it, for the journal and the dashboard. */
  signalId: string;
}

export interface ExitDecision {
  symbol: string;
  reason: ExitReason;
  /** Human-readable, shown in the activity feed and Discord. */
  message: string;
  currentPrice: number;
  entryPrice: number;
  pnlPercent: number;
}

/** Horizon labels a signal can carry, mapped to a holding deadline. */
const HORIZON_DAYS: Record<string, number> = {
  intraday: 1,
  '1-5d': 5,
  '1-4w': 28,
  '1-6m': 180,
  // "unclear" gets the default rather than an open-ended hold: a thesis with
  // no stated horizon is not a thesis with an infinite one.
  unclear: 5,
};

/** Used when a signal's horizon is missing or unrecognised. */
const DEFAULT_HORIZON_DAYS = 5;

export function horizonDays(horizon: string | undefined): number {
  if (!horizon) return DEFAULT_HORIZON_DAYS;
  return HORIZON_DAYS[horizon] ?? DEFAULT_HORIZON_DAYS;
}

export interface PositionManagerOptions {
  /**
   * Take-profit distance as a multiple of the stop distance. 2 means "risk one
   * unit to make two". A convention, not a measured optimum.
   */
  rewardToRisk?: number;
  clock?: Clock;
}

export class PositionManager {
  private readonly managed = new Map<string, ManagedPosition>();
  private readonly rewardToRisk: number;
  private readonly clock: Clock;

  constructor(options: PositionManagerOptions = {}) {
    this.rewardToRisk = options.rewardToRisk ?? 2;
    this.clock = options.clock ?? systemClock;
  }

  /** Record the exit plan for a newly opened position. */
  track(input: {
    symbol: string;
    entryPrice: number;
    stopPrice: number;
    horizon?: string;
    signalId: string;
  }): ManagedPosition {
    const stopDistance = input.entryPrice - input.stopPrice;
    const opened = this.clock.now();
    const managed: ManagedPosition = {
      symbol: input.symbol,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      takeProfitPrice: Number((input.entryPrice + stopDistance * this.rewardToRisk).toFixed(4)),
      expiresAt: new Date(
        opened.getTime() + horizonDays(input.horizon) * 86_400_000,
      ).toISOString(),
      openedAt: opened.toISOString(),
      signalId: input.signalId,
    };
    this.managed.set(input.symbol, managed);
    return managed;
  }

  forget(symbol: string): void {
    this.managed.delete(symbol);
  }

  get(symbol: string): ManagedPosition | undefined {
    return this.managed.get(symbol);
  }

  all(): ManagedPosition[] {
    return [...this.managed.values()];
  }

  /**
   * Adopt a position that has no exit plan.
   *
   * Happens after a restart from an older state file, or if a position is ever
   * opened outside the normal path. Leaving it unmanaged would silently
   * recreate the hole this file exists to close, so it gets a plan derived from
   * its entry price rather than none at all.
   */
  adoptIfUntracked(position: Position, stopDistancePct: number): void {
    if (this.managed.has(position.symbol)) return;
    this.track({
      symbol: position.symbol,
      entryPrice: position.averagePrice,
      stopPrice: Number((position.averagePrice * (1 - stopDistancePct / 100)).toFixed(4)),
      signalId: 'adopted',
    });
  }

  /**
   * Which open positions should be closed now.
   *
   * `prices` may omit a symbol — a quote can be stale or missing, and this must
   * not throw. But an unpriceable position is *not* safe: it is a position
   * whose stop cannot be checked, which the caller should surface rather than
   * ignore.
   */
  exitsDue(positions: Position[], prices: Map<string, number>): ExitDecision[] {
    const now = this.clock.now().getTime();
    const exits: ExitDecision[] = [];

    for (const position of positions) {
      if (position.quantity <= 0) continue;
      const plan = this.managed.get(position.symbol);
      if (!plan) continue;

      const price = prices.get(position.symbol);
      if (price === undefined || !Number.isFinite(price)) continue;

      const pnlPercent = Number(((price / plan.entryPrice - 1) * 100).toFixed(3));
      const base = {
        symbol: position.symbol,
        currentPrice: price,
        entryPrice: plan.entryPrice,
        pnlPercent,
      };

      // Stop first: when both a stop and a target could be argued from the
      // same bar, the loss is the one that matters.
      if (price <= plan.stopPrice) {
        exits.push({
          ...base,
          reason: 'stop_loss',
          message: `stop ${plan.stopPrice} hit at ${price} (${pnlPercent}%)`,
        });
        continue;
      }

      if (price >= plan.takeProfitPrice) {
        exits.push({
          ...base,
          reason: 'take_profit',
          message: `target ${plan.takeProfitPrice} reached at ${price} (+${pnlPercent}%)`,
        });
        continue;
      }

      if (now >= Date.parse(plan.expiresAt)) {
        exits.push({
          ...base,
          reason: 'horizon',
          message: `held past its ${plan.expiresAt.slice(0, 10)} horizon (${pnlPercent}%)`,
        });
      }
    }

    return exits;
  }

  /** Positions held with no usable price, so no stop could be evaluated. */
  unpriceable(positions: Position[], prices: Map<string, number>): string[] {
    return positions
      .filter((p) => p.quantity > 0 && this.managed.has(p.symbol))
      .filter((p) => {
        const price = prices.get(p.symbol);
        return price === undefined || !Number.isFinite(price);
      })
      .map((p) => p.symbol);
  }

  /** Serialisable state, so exit plans survive a restart. */
  serialize(): ManagedPosition[] {
    return this.all();
  }

  restore(plans: ManagedPosition[]): void {
    for (const plan of plans) this.managed.set(plan.symbol, plan);
  }
}
