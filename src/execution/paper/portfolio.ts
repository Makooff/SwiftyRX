import { type Clock, systemClock } from '../../core/clock.js';
import type { PortfolioSnapshot, Position } from '../../risk/types.js';

/**
 * Virtual portfolio.
 *
 * Tracks cash, positions, realised and unrealised P&L, drawdown and the
 * counters the Risk Engine reads. It records losses as prominently as gains —
 * peak value and maximum drawdown are first-class, not derived on demand for a
 * flattering chart.
 */

export interface ClosedTrade {
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: string;
  closedAt: string;
  /** Net of all costs. */
  realisedPnl: number;
  costs: number;
  returnPct: number;
}

export interface PortfolioOptions {
  initialCash: number;
  currency?: string;
  clock?: Clock;
}

/**
 * Everything mutable in a portfolio, in a form that survives a restart.
 *
 * Deliberately a plain data shape rather than a class dump: it has to be
 * readable by a human deciding whether to trust a state file, and diffable when
 * a run does something surprising.
 */
export interface PortfolioState {
  version: 1;
  currency: string;
  initialCash: number;
  cash: number;
  positions: Position[];
  closedTrades: ClosedTrade[];
  marks: Record<string, number>;
  peak: number;
  maxDrawdownPct: number;
  dayStart: number;
  dayStartedOn: string;
  realisedPnlToday: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastLossAt?: string;
}

export class Portfolio {
  readonly currency: string;
  readonly initialCash: number;

  private cash: number;
  private readonly positions = new Map<string, Position>();
  private readonly closedTrades: ClosedTrade[] = [];
  private readonly marks = new Map<string, number>();
  private readonly clock: Clock;

  private peak: number;
  private maxDrawdownPct = 0;
  private dayStart: number;
  private dayStartedOn: string;
  private realisedPnlToday = 0;
  private tradesToday = 0;
  private consecutiveLosses = 0;
  private lastLossAt?: string;

  constructor(options: PortfolioOptions) {
    this.clock = options.clock ?? systemClock;
    this.currency = options.currency ?? 'EUR';
    this.initialCash = options.initialCash;
    this.cash = options.initialCash;
    this.peak = options.initialCash;
    this.dayStart = options.initialCash;
    this.dayStartedOn = this.clock.now().toISOString().slice(0, 10);
  }

  /** Update the last known price for a symbol. */
  mark(symbol: string, price: number): void {
    this.marks.set(symbol, price);
    const position = this.positions.get(symbol);
    if (position) {
      position.marketValue = Number((position.quantity * price).toFixed(2));
      position.unrealisedPnl = Number(
        (position.quantity * (price - position.averagePrice)).toFixed(2),
      );
    }
    this.updatePeak();
  }

  private updatePeak(): void {
    const value = this.totalValue;
    if (value > this.peak) this.peak = value;
    const drawdown = this.peak > 0 ? ((this.peak - value) / this.peak) * 100 : 0;
    if (drawdown > this.maxDrawdownPct) this.maxDrawdownPct = drawdown;
  }

  /** Roll daily counters when the calendar date changes. */
  private rollDayIfNeeded(): void {
    const today = this.clock.now().toISOString().slice(0, 10);
    if (today !== this.dayStartedOn) {
      this.dayStartedOn = today;
      this.dayStart = this.totalValue;
      this.realisedPnlToday = 0;
      this.tradesToday = 0;
    }
  }

  /**
   * Apply a buy fill. `fillPrice` must already include spread and slippage;
   * `commission` is charged separately against cash.
   */
  applyBuy(symbol: string, quantity: number, fillPrice: number, commission: number): void {
    this.rollDayIfNeeded();
    const cost = quantity * fillPrice + commission;
    this.cash = Number((this.cash - cost).toFixed(2));

    const existing = this.positions.get(symbol);
    if (existing) {
      const totalQuantity = existing.quantity + quantity;
      // Commission is capitalised into the average price so the break-even
      // shown to the operator is the real one.
      const totalCost = existing.quantity * existing.averagePrice + quantity * fillPrice + commission;
      existing.quantity = Number(totalQuantity.toFixed(6));
      existing.averagePrice = Number((totalCost / totalQuantity).toFixed(4));
    } else {
      this.positions.set(symbol, {
        symbol,
        quantity: Number(quantity.toFixed(6)),
        averagePrice: Number(((quantity * fillPrice + commission) / quantity).toFixed(4)),
        currency: this.currency,
        marketValue: Number((quantity * fillPrice).toFixed(2)),
        unrealisedPnl: 0,
        openedAt: this.clock.now().toISOString(),
      });
    }

    this.tradesToday += 1;
    this.mark(symbol, fillPrice);
  }

  /** Apply a sell fill, realising P&L on the quantity sold. */
  applySell(symbol: string, quantity: number, fillPrice: number, commission: number): ClosedTrade | undefined {
    this.rollDayIfNeeded();
    const position = this.positions.get(symbol);
    if (!position || position.quantity <= 0) return undefined;

    const sold = Math.min(quantity, position.quantity);
    const proceeds = sold * fillPrice - commission;
    this.cash = Number((this.cash + proceeds).toFixed(2));

    const realisedPnl = Number((sold * (fillPrice - position.averagePrice) - commission).toFixed(2));
    this.realisedPnlToday = Number((this.realisedPnlToday + realisedPnl).toFixed(2));
    this.tradesToday += 1;

    const trade: ClosedTrade = {
      symbol,
      quantity: sold,
      entryPrice: position.averagePrice,
      exitPrice: fillPrice,
      openedAt: position.openedAt,
      closedAt: this.clock.now().toISOString(),
      realisedPnl,
      costs: commission,
      returnPct: Number(((fillPrice / position.averagePrice - 1) * 100).toFixed(3)),
    };
    this.closedTrades.push(trade);

    if (realisedPnl < 0) {
      this.consecutiveLosses += 1;
      this.lastLossAt = trade.closedAt;
    } else {
      this.consecutiveLosses = 0;
    }

    position.quantity = Number((position.quantity - sold).toFixed(6));
    if (position.quantity <= 0.000001) {
      this.positions.delete(symbol);
    } else {
      this.mark(symbol, fillPrice);
    }

    this.updatePeak();
    return trade;
  }

  get availableCash(): number {
    return this.cash;
  }

  get totalValue(): number {
    const positionsValue = [...this.positions.values()].reduce(
      (sum, p) => sum + p.quantity * (this.marks.get(p.symbol) ?? p.averagePrice),
      0,
    );
    return Number((this.cash + positionsValue).toFixed(2));
  }

  get openPositions(): Position[] {
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  get trades(): ClosedTrade[] {
    return [...this.closedTrades];
  }

  get drawdownPct(): number {
    const value = this.totalValue;
    return this.peak > 0 ? Number((((this.peak - value) / this.peak) * 100).toFixed(3)) : 0;
  }

  get maxDrawdown(): number {
    return Number(this.maxDrawdownPct.toFixed(3));
  }

  get totalReturnPct(): number {
    return this.initialCash > 0
      ? Number(((this.totalValue / this.initialCash - 1) * 100).toFixed(3))
      : 0;
  }

  get exposurePct(): number {
    const value = this.totalValue;
    if (value <= 0) return 0;
    const exposure = [...this.positions.values()].reduce(
      (sum, p) => sum + Math.abs(p.quantity * (this.marks.get(p.symbol) ?? p.averagePrice)),
      0,
    );
    return Number(((exposure / value) * 100).toFixed(2));
  }

  /** Full mutable state, for persistence across restarts. */
  serialize(): PortfolioState {
    return {
      version: 1,
      currency: this.currency,
      initialCash: this.initialCash,
      cash: this.cash,
      positions: this.openPositions,
      closedTrades: this.trades,
      marks: Object.fromEntries(this.marks),
      peak: this.peak,
      maxDrawdownPct: this.maxDrawdownPct,
      dayStart: this.dayStart,
      dayStartedOn: this.dayStartedOn,
      realisedPnlToday: this.realisedPnlToday,
      tradesToday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
      ...(this.lastLossAt ? { lastLossAt: this.lastLossAt } : {}),
    };
  }

  /**
   * Rebuild a portfolio from a serialised state.
   *
   * `initialCash` comes from the state, not from configuration: restoring a
   * €10,000 run into a portfolio that believes it started at €300 would report
   * a return of +3000% on the first cycle. The caller is responsible for
   * deciding whether the state belongs to this configuration at all — see
   * `AgentStateStore`, which refuses a mismatch rather than reconciling it.
   */
  static restore(state: PortfolioState, options: { clock?: Clock } = {}): Portfolio {
    if (state.version !== 1) {
      throw new Error(`Unsupported portfolio state version: ${String(state.version)}`);
    }

    const portfolio = new Portfolio({
      initialCash: state.initialCash,
      currency: state.currency,
      ...(options.clock ? { clock: options.clock } : {}),
    });

    portfolio.cash = state.cash;
    for (const position of state.positions) portfolio.positions.set(position.symbol, { ...position });
    portfolio.closedTrades.push(...state.closedTrades);
    for (const [symbol, price] of Object.entries(state.marks)) portfolio.marks.set(symbol, price);
    portfolio.peak = state.peak;
    portfolio.maxDrawdownPct = state.maxDrawdownPct;
    portfolio.dayStart = state.dayStart;
    portfolio.dayStartedOn = state.dayStartedOn;
    portfolio.realisedPnlToday = state.realisedPnlToday;
    portfolio.tradesToday = state.tradesToday;
    portfolio.consecutiveLosses = state.consecutiveLosses;
    if (state.lastLossAt) portfolio.lastLossAt = state.lastLossAt;

    return portfolio;
  }

  /** The view the Risk Engine consumes. */
  snapshot(): PortfolioSnapshot {
    this.rollDayIfNeeded();
    return {
      cash: this.cash,
      currency: this.currency,
      positions: this.openPositions,
      totalValue: this.totalValue,
      dayStartValue: this.dayStart,
      peakValue: Number(this.peak.toFixed(2)),
      realisedPnlToday: this.realisedPnlToday,
      tradesToday: this.tradesToday,
      consecutiveLosses: this.consecutiveLosses,
      ...(this.lastLossAt ? { lastLossAt: this.lastLossAt } : {}),
    };
  }
}
