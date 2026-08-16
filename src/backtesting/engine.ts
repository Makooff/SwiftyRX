import { FixedClock } from '../core/clock.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { Bar } from '../domain/types.js';
import { DEFAULT_COST_MODEL, estimateFill, type CostModel } from '../execution/costs.js';
import { Portfolio } from '../execution/paper/portfolio.js';
import { detectRegime, type MarketRegime } from '../strategy/regime.js';
import { computeMetrics, type EquityPoint, type PerformanceMetrics, type TradeRecord } from './metrics.js';

/**
 * Event-driven backtesting engine.
 *
 * The design constraint that matters more than any other here is **avoiding
 * look-ahead bias**. Three mechanisms enforce it:
 *
 * 1. A strategy is only ever handed bars up to and including the current one.
 *    Future bars are physically not in the slice it receives.
 * 2. Orders decided on bar *i* fill on bar *i+1*'s open, never on bar *i*'s
 *    close. Deciding and filling on the same price is the classic way a
 *    backtest invents returns that were never available.
 * 3. Time comes from a FixedClock advanced by the engine, so nothing can read
 *    the wall clock and see beyond the simulated present.
 *
 * Costs are applied to every fill. A backtest without them measures a
 * different, easier game.
 */

export interface StrategyContext {
  /** Bars up to and including today. Never contains the future. */
  history: Bar[];
  today: Bar;
  regime: MarketRegime;
  portfolio: Portfolio;
  /** Current position size in this symbol; zero when flat. */
  positionQuantity: number;
}

export type StrategyDecision =
  | { action: 'buy'; /** Fraction of portfolio value to allocate, 0-1. */ sizeFraction: number; reason: string }
  | { action: 'sell'; reason: string }
  | { action: 'hold' };

export interface BacktestStrategy {
  readonly id: string;
  /** Bars needed before the strategy produces its first decision. */
  readonly warmupBars: number;
  decide(context: StrategyContext): StrategyDecision;
}

export interface BacktestOptions {
  bars: Bar[];
  strategy: BacktestStrategy;
  initialCapital: number;
  costModel?: CostModel;
  currency?: string;
  riskFreeRate?: number;
  logger?: Logger;
  /**
   * Cap on position size as a fraction of portfolio value. Defaults to 1 —
   * the backtest engine does not impose risk limits of its own, because a
   * silent cap here would misreport what the strategy actually did (a
   * "buy and hold" baseline capped at 20% is not buy and hold).
   * Position limits are the Risk Engine's job in live and paper trading.
   */
  maxPositionFraction?: number;
}

export interface BacktestResult {
  strategyId: string;
  symbol: string;
  from: string;
  to: string;
  metrics: PerformanceMetrics;
  equityCurve: EquityPoint[];
  trades: TradeRecord[];
  /** Decisions that produced no trade, and why. */
  skipped: number;
}

export function runBacktest(options: BacktestOptions): BacktestResult {
  const log = options.logger ?? createLogger('backtest');
  const costModel = options.costModel ?? DEFAULT_COST_MODEL;
  const maxPositionFraction = options.maxPositionFraction ?? 1;

  const bars = [...options.bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (bars.length < options.strategy.warmupBars + 2) {
    throw new Error(
      `Not enough bars: need at least ${options.strategy.warmupBars + 2}, received ${bars.length}`,
    );
  }

  const symbol = bars[0]!.symbol;
  const clock = FixedClock.at(bars[0]!.timestamp);
  const portfolio = new Portfolio({
    initialCash: options.initialCapital,
    ...(options.currency ? { currency: options.currency } : {}),
    clock,
  });

  const equityCurve: EquityPoint[] = [];
  const trades: TradeRecord[] = [];
  let skipped = 0;

  // Pending order decided on the previous bar, filled at this bar's open.
  let pending: { action: 'buy' | 'sell'; sizeFraction?: number; reason: string } | undefined;
  let openEntry: { price: number; date: string; quantity: number; costs: number } | undefined;

  for (let i = options.strategy.warmupBars; i < bars.length; i++) {
    const today = bars[i]!;
    clock.set(today.timestamp);

    // --- Execute yesterday's decision at today's open --------------------
    if (pending) {
      const referencePrice = today.open;
      if (pending.action === 'buy') {
        const budget = portfolio.totalValue * Math.min(maxPositionFraction, pending.sizeFraction ?? 0);
        const provisional = estimateFill(referencePrice, 1, 'buy', costModel);
        const quantity = provisional.fillPrice > 0 ? Math.floor(budget / provisional.fillPrice) : 0;

        if (quantity > 0) {
          const fill = estimateFill(referencePrice, quantity, 'buy', costModel);
          const cost = quantity * fill.fillPrice + fill.commission;
          if (cost <= portfolio.availableCash) {
            portfolio.applyBuy(symbol, quantity, fill.fillPrice, fill.commission);
            openEntry = {
              price: fill.fillPrice,
              date: today.timestamp,
              quantity,
              costs: fill.totalCost,
            };
          } else {
            skipped += 1;
          }
        } else {
          // Common with small capital and high-priced shares — recorded rather
          // than silently ignored.
          skipped += 1;
        }
      } else {
        const position = portfolio.openPositions.find((p) => p.symbol === symbol);
        if (position && position.quantity > 0) {
          const fill = estimateFill(referencePrice, position.quantity, 'sell', costModel);
          const closed = portfolio.applySell(symbol, position.quantity, fill.fillPrice, fill.commission);
          if (closed && openEntry) {
            trades.push({
              symbol,
              entryDate: openEntry.date,
              exitDate: today.timestamp,
              pnl: closed.realisedPnl,
              returnPct: closed.returnPct,
              costs: Number((openEntry.costs + fill.totalCost).toFixed(2)),
            });
          }
          openEntry = undefined;
        } else {
          skipped += 1;
        }
      }
      pending = undefined;
    }

    // Mark to today's close for the equity curve.
    portfolio.mark(symbol, today.close);
    equityCurve.push({ date: today.timestamp, value: portfolio.totalValue });

    // --- Decide on today's information, act tomorrow ---------------------
    const history = bars.slice(0, i + 1);
    const position = portfolio.openPositions.find((p) => p.symbol === symbol);
    const decision = options.strategy.decide({
      history,
      today,
      regime: detectRegime(history),
      portfolio,
      positionQuantity: position?.quantity ?? 0,
    });

    if (decision.action === 'buy' && (position?.quantity ?? 0) === 0) {
      pending = { action: 'buy', sizeFraction: decision.sizeFraction, reason: decision.reason };
    } else if (decision.action === 'sell' && (position?.quantity ?? 0) > 0) {
      pending = { action: 'sell', reason: decision.reason };
    }
  }

  // Close any open position at the final close so the result reflects a
  // realised outcome rather than a hopeful mark.
  const finalBar = bars[bars.length - 1]!;
  const remaining = portfolio.openPositions.find((p) => p.symbol === symbol);
  if (remaining && remaining.quantity > 0) {
    const fill = estimateFill(finalBar.close, remaining.quantity, 'sell', costModel);
    const closed = portfolio.applySell(symbol, remaining.quantity, fill.fillPrice, fill.commission);
    if (closed && openEntry) {
      trades.push({
        symbol,
        entryDate: openEntry.date,
        exitDate: finalBar.timestamp,
        pnl: closed.realisedPnl,
        returnPct: closed.returnPct,
        costs: Number((openEntry.costs + fill.totalCost).toFixed(2)),
      });
    }
    equityCurve.push({ date: finalBar.timestamp, value: portfolio.totalValue });
  }

  const firstClose = bars[options.strategy.warmupBars]!.close;
  const buyAndHoldReturnPct = firstClose > 0 ? (finalBar.close / firstClose - 1) * 100 : 0;

  const metrics = computeMetrics(equityCurve, trades, {
    ...(options.riskFreeRate !== undefined ? { riskFreeRate: options.riskFreeRate } : {}),
    buyAndHoldReturnPct,
  });

  log.info(
    {
      strategy: options.strategy.id,
      trades: trades.length,
      totalReturnPct: metrics.totalReturnPct,
      buyAndHoldReturnPct: metrics.buyAndHoldReturnPct,
      maxDrawdownPct: metrics.maxDrawdownPct,
    },
    'backtest complete',
  );

  return {
    strategyId: options.strategy.id,
    symbol,
    from: bars[options.strategy.warmupBars]!.timestamp,
    to: finalBar.timestamp,
    metrics,
    equityCurve,
    trades,
    skipped,
  };
}
