import type { SignalAction } from '../strategy/signals/types.js';

/**
 * Risk domain.
 *
 * The Risk Engine consumes a *proposal* and returns a *decision*. It never
 * reads the model's reasoning text and never sees the prompt — its inputs are
 * numbers it can check: prices, exposures, losses, counts, timestamps.
 */

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currency: string;
  /** Marked value at the last known price. */
  marketValue: number;
  unrealisedPnl: number;
  openedAt: string;
  /** Sector/asset-class label used for correlated-exposure checks. */
  correlationGroup?: string;
}

export interface PortfolioSnapshot {
  cash: number;
  currency: string;
  positions: Position[];
  /** Cash plus marked positions. */
  totalValue: number;
  /** Value at the start of the current trading day. */
  dayStartValue: number;
  /** Peak total value seen, for drawdown. */
  peakValue: number;
  realisedPnlToday: number;
  tradesToday: number;
  /** Consecutive losing trades, most recent first. */
  consecutiveLosses: number;
  lastLossAt?: string;
}

export type RiskVerdict = 'approved' | 'rejected' | 'reduced';

export interface RiskRejection {
  /** Machine-readable rule id, e.g. "max_daily_loss". */
  rule: string;
  message: string;
  /** True when the rule blocks all trading, not just this order. */
  halting: boolean;
}

export interface RiskDecision {
  verdict: RiskVerdict;
  /** Quantity approved. Zero when rejected. */
  quantity: number;
  /** Notional value of the approved order. */
  notional: number;
  symbol: string;
  side: 'buy' | 'sell';
  /** Every rule that ran, in order, with its outcome. */
  checks: Array<{ rule: string; passed: boolean; detail: string }>;
  rejections: RiskRejection[];
  /** Stop-loss price implied by the sizing calculation. */
  stopPrice?: number;
  /** Risk taken on this trade as a percentage of portfolio value. */
  riskPercent?: number;
  decidedAt: string;
}

export interface RiskRequest {
  symbol: string;
  action: SignalAction;
  /** Composite signal score in [0,1]. */
  score: number;
  /** Current price. Must come from a freshness-checked quote. */
  price: number;
  /** Age of that price in seconds. */
  priceAgeSeconds: number;
  /** Annualised volatility, used for stop distance when available. */
  volatilityPct?: number;
  correlationGroup?: string;
  /** Idempotency key so a retry cannot place the same order twice. */
  clientOrderId: string;
}
