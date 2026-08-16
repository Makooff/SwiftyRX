/**
 * Performance metrics.
 *
 * Every metric here is computed net of costs, because gross performance is not
 * a result — it is a description of a game nobody plays. Where a metric is
 * unreliable at small sample sizes, the sample size is returned alongside it so
 * a reader cannot quote the number without the caveat.
 */

const TRADING_DAYS_PER_YEAR = 252;

export interface EquityPoint {
  date: string;
  value: number;
}

export interface TradeRecord {
  symbol: string;
  entryDate: string;
  exitDate: string;
  /** Net of all costs. */
  pnl: number;
  returnPct: number;
  costs: number;
}

export interface PerformanceMetrics {
  totalReturnPct: number;
  annualisedReturnPct: number;
  volatilityPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  profitFactor: number;
  averageTradePnl: number;
  numberOfTrades: number;
  totalCosts: number;
  /** Costs as a percentage of starting capital. */
  costDragPct: number;
  buyAndHoldReturnPct?: number;
  excessOverBuyAndHoldPct?: number;
  /** Days covered by the equity curve. */
  periodDays: number;
  /**
   * Rough t-statistic on the Sharpe ratio (Sharpe × √years). Below about 2 the
   * result is not distinguishable from luck.
   */
  sharpeTStat: number;
  /** Plain-language verdict on whether the sample supports any conclusion. */
  statisticalWarning?: string;
}

export function dailyReturnsFromEquity(curve: EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const previous = curve[i - 1]!.value;
    if (previous > 0) returns.push(curve[i]!.value / previous - 1);
  }
  return returns;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1));
}

/** Standard deviation of negative returns only. */
function downsideDeviation(values: number[], target = 0): number {
  const shortfalls = values.filter((v) => v < target).map((v) => (v - target) ** 2);
  if (shortfalls.length === 0) return 0;
  return Math.sqrt(shortfalls.reduce((sum, v) => sum + v, 0) / shortfalls.length);
}

export function maxDrawdownPct(curve: EquityPoint[]): number {
  let peak = curve[0]?.value ?? 0;
  let worst = 0;
  for (const point of curve) {
    if (point.value > peak) peak = point.value;
    if (peak > 0) {
      const drawdown = ((peak - point.value) / peak) * 100;
      if (drawdown > worst) worst = drawdown;
    }
  }
  return Number(worst.toFixed(3));
}

export interface MetricsOptions {
  /** Annual risk-free rate as a decimal, e.g. 0.03. */
  riskFreeRate?: number;
  /** Buy & hold return over the same period, in percent. */
  buyAndHoldReturnPct?: number;
}

export function computeMetrics(
  curve: EquityPoint[],
  trades: TradeRecord[],
  options: MetricsOptions = {},
): PerformanceMetrics {
  const riskFree = options.riskFreeRate ?? 0;

  const start = curve[0]?.value ?? 0;
  const end = curve[curve.length - 1]?.value ?? 0;
  const totalReturn = start > 0 ? (end / start - 1) * 100 : 0;

  const periodDays =
    curve.length >= 2
      ? Math.max(
          1,
          (Date.parse(curve[curve.length - 1]!.date) - Date.parse(curve[0]!.date)) / 86_400_000,
        )
      : 0;
  const years = periodDays / 365.25;

  const annualised =
    years > 0 && start > 0 ? ((end / start) ** (1 / years) - 1) * 100 : 0;

  const returns = dailyReturnsFromEquity(curve);
  const dailyVol = standardDeviation(returns);
  const volatility = dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;

  const dailyRiskFree = riskFree / TRADING_DAYS_PER_YEAR;
  const excess = returns.map((r) => r - dailyRiskFree);
  const sharpe =
    dailyVol > 0 ? (mean(excess) / dailyVol) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  const downside = downsideDeviation(excess);
  const sortino = downside > 0 ? (mean(excess) / downside) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const totalCosts = trades.reduce((sum, t) => sum + t.costs, 0);

  // t ≈ Sharpe × √years. Below ~2, the track record cannot distinguish skill
  // from luck at conventional significance.
  const sharpeTStat = years > 0 ? sharpe * Math.sqrt(years) : 0;

  let statisticalWarning: string | undefined;
  if (trades.length < 30) {
    statisticalWarning = `Only ${trades.length} trades — far too few to support any conclusion about the strategy.`;
  } else if (Math.abs(sharpeTStat) < 2) {
    statisticalWarning = `t-statistic on the Sharpe ratio is ${sharpeTStat.toFixed(2)} (|t| < 2): this result is not distinguishable from luck. Roughly ${(4 / Math.max(0.1, sharpe) ** 2).toFixed(1)} years of data would be needed at this Sharpe.`;
  }

  return {
    totalReturnPct: Number(totalReturn.toFixed(3)),
    annualisedReturnPct: Number(annualised.toFixed(3)),
    volatilityPct: Number(volatility.toFixed(3)),
    sharpeRatio: Number(sharpe.toFixed(3)),
    sortinoRatio: Number(sortino.toFixed(3)),
    maxDrawdownPct: maxDrawdownPct(curve),
    winRate: trades.length > 0 ? Number((wins.length / trades.length).toFixed(4)) : 0,
    // Infinity would be misleading; a strategy with no losses yet simply has
    // not had one yet.
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit > 0 ? 999 : 0,
    averageTradePnl:
      trades.length > 0
        ? Number((trades.reduce((sum, t) => sum + t.pnl, 0) / trades.length).toFixed(2))
        : 0,
    numberOfTrades: trades.length,
    totalCosts: Number(totalCosts.toFixed(2)),
    costDragPct: start > 0 ? Number(((totalCosts / start) * 100).toFixed(3)) : 0,
    ...(options.buyAndHoldReturnPct !== undefined
      ? {
          buyAndHoldReturnPct: Number(options.buyAndHoldReturnPct.toFixed(3)),
          excessOverBuyAndHoldPct: Number((totalReturn - options.buyAndHoldReturnPct).toFixed(3)),
        }
      : {}),
    periodDays: Math.round(periodDays),
    sharpeTStat: Number(sharpeTStat.toFixed(3)),
    ...(statisticalWarning ? { statisticalWarning } : {}),
  };
}
