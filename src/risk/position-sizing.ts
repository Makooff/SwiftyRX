/**
 * Position sizing.
 *
 * Risk-based rather than conviction-based: the size follows from how much the
 * portfolio can afford to lose if the stop is hit, not from how confident the
 * model felt. Confidence scales the risk budget within a hard cap; it never
 * sets the size directly.
 */

export interface SizingInputs {
  portfolioValue: number;
  price: number;
  /** Maximum fraction of portfolio value to risk on one trade, in percent. */
  maxSingleTradeRiskPercent: number;
  /** Maximum fraction of the portfolio one position may occupy, in percent. */
  maxPositionPercent: number;
  /** Composite signal score in [0,1], used to scale within the risk cap. */
  score: number;
  /** Annualised volatility in percent; wider stops for more volatile names. */
  volatilityPct?: number;
  /** Whether the broker supports fractional quantities. */
  allowFractional?: boolean;
}

export interface SizingResult {
  quantity: number;
  notional: number;
  stopPrice: number;
  stopDistancePct: number;
  riskAmount: number;
  riskPercent: number;
  /** Which constraint determined the final size. */
  boundBy: 'risk_budget' | 'position_cap' | 'price' | 'zero';
}

/** Fallback stop distance when volatility is unknown. */
const DEFAULT_STOP_DISTANCE_PCT = 5;
const MIN_STOP_DISTANCE_PCT = 2;
const MAX_STOP_DISTANCE_PCT = 15;
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Stop distance from volatility.
 *
 * Roughly two daily standard deviations, bounded. A stop tighter than the
 * asset's normal daily noise is a guaranteed exit on nothing; one much wider
 * turns a small position into a large loss.
 */
export function stopDistancePct(volatilityPct?: number): number {
  if (volatilityPct === undefined || volatilityPct <= 0) return DEFAULT_STOP_DISTANCE_PCT;
  const dailyVol = volatilityPct / Math.sqrt(TRADING_DAYS_PER_YEAR);
  return Math.min(MAX_STOP_DISTANCE_PCT, Math.max(MIN_STOP_DISTANCE_PCT, dailyVol * 2));
}

export function sizePosition(inputs: SizingInputs): SizingResult {
  const distancePct = stopDistancePct(inputs.volatilityPct);
  const stopPrice = Number((inputs.price * (1 - distancePct / 100)).toFixed(4));

  if (inputs.price <= 0 || inputs.portfolioValue <= 0) {
    return {
      quantity: 0,
      notional: 0,
      stopPrice,
      stopDistancePct: distancePct,
      riskAmount: 0,
      riskPercent: 0,
      boundBy: 'zero',
    };
  }

  // Score scales the risk budget between 40% and 100% of the cap. Even a
  // perfect score cannot exceed the configured maximum.
  const scoreFactor = 0.4 + 0.6 * Math.max(0, Math.min(1, inputs.score));
  const riskBudget = inputs.portfolioValue * (inputs.maxSingleTradeRiskPercent / 100) * scoreFactor;

  const riskPerShare = inputs.price * (distancePct / 100);
  const riskBasedQuantity = riskPerShare > 0 ? riskBudget / riskPerShare : 0;

  const positionCap = inputs.portfolioValue * (inputs.maxPositionPercent / 100);
  const capQuantity = positionCap / inputs.price;

  let quantity = Math.min(riskBasedQuantity, capQuantity);
  const boundBy: SizingResult['boundBy'] = riskBasedQuantity <= capQuantity ? 'risk_budget' : 'position_cap';

  if (!inputs.allowFractional) {
    quantity = Math.floor(quantity);
  } else {
    quantity = Number(quantity.toFixed(6));
  }

  if (quantity <= 0) {
    // A whole-share broker plus a small account produces this often; saying so
    // is more useful than silently placing nothing.
    return {
      quantity: 0,
      notional: 0,
      stopPrice,
      stopDistancePct: distancePct,
      riskAmount: 0,
      riskPercent: 0,
      boundBy: 'price',
    };
  }

  const notional = Number((quantity * inputs.price).toFixed(2));
  const riskAmount = Number((quantity * riskPerShare).toFixed(2));

  return {
    quantity,
    notional,
    stopPrice,
    stopDistancePct: Number(distancePct.toFixed(2)),
    riskAmount,
    riskPercent: Number(((riskAmount / inputs.portfolioValue) * 100).toFixed(3)),
    boundBy,
  };
}
