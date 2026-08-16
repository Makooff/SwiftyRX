/**
 * Transaction cost model.
 *
 * Costs are modelled explicitly and applied to every simulated fill, because a
 * strategy that is profitable gross and unprofitable net is unprofitable. Paper
 * results that ignore commission and spread are not optimistic — they are
 * measuring a different, easier game than the one the money would play.
 *
 * Defaults are deliberately pessimistic. Under-modelling costs is the single
 * most common way a backtest flatters a strategy.
 */

export interface CostModel {
  /** Fixed fee per order, in account currency. */
  commissionPerOrder: number;
  /** Proportional fee, in basis points of notional. */
  commissionBps: number;
  /** Half-spread paid on entry and exit, in basis points. */
  halfSpreadBps: number;
  /** Additional market-impact slippage, in basis points. */
  slippageBps: number;
  /** Minimum commission per order. */
  minimumCommission: number;
}

/**
 * A plausible European retail broker on US equities. Verify against your own
 * broker's schedule before drawing conclusions from any backtest.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  commissionPerOrder: 1.0,
  commissionBps: 0,
  halfSpreadBps: 2.5,
  slippageBps: 2.5,
  minimumCommission: 1.0,
};

/** Zero-cost model. Only for isolating strategy behaviour in tests. */
export const ZERO_COST_MODEL: CostModel = {
  commissionPerOrder: 0,
  commissionBps: 0,
  halfSpreadBps: 0,
  slippageBps: 0,
  minimumCommission: 0,
};

export interface FillEstimate {
  /** Price actually paid or received, after spread and impact. */
  fillPrice: number;
  commission: number;
  /** Cost of crossing the spread plus impact, in currency. */
  slippage: number;
  /** Commission plus slippage. */
  totalCost: number;
  /** Total cost as a percentage of notional. */
  costPercent: number;
}

export function estimateFill(
  referencePrice: number,
  quantity: number,
  side: 'buy' | 'sell',
  model: CostModel = DEFAULT_COST_MODEL,
): FillEstimate {
  const adverseBps = model.halfSpreadBps + model.slippageBps;
  // Costs always work against the trade: buys fill higher, sells fill lower.
  const direction = side === 'buy' ? 1 : -1;
  const fillPrice = Number((referencePrice * (1 + (direction * adverseBps) / 10_000)).toFixed(4));

  const notional = Math.abs(quantity * fillPrice);
  const commission = Number(
    Math.max(
      model.minimumCommission,
      model.commissionPerOrder + (notional * model.commissionBps) / 10_000,
    ).toFixed(2),
  );
  const slippage = Number(Math.abs((fillPrice - referencePrice) * quantity).toFixed(2));
  const totalCost = Number((commission + slippage).toFixed(2));

  return {
    fillPrice,
    commission,
    slippage,
    totalCost,
    costPercent: notional > 0 ? Number(((totalCost / notional) * 100).toFixed(4)) : 0,
  };
}

/**
 * Round-trip cost of a position as a percentage of notional.
 *
 * Useful as a sanity check before trading: if the expected move is smaller
 * than this, the trade cannot be profitable no matter how right the analysis is.
 */
export function roundTripCostPercent(
  price: number,
  quantity: number,
  model: CostModel = DEFAULT_COST_MODEL,
): number {
  const entry = estimateFill(price, quantity, 'buy', model);
  const exit = estimateFill(price, quantity, 'sell', model);
  const notional = Math.abs(price * quantity);
  if (notional === 0) return 0;
  return Number((((entry.totalCost + exit.totalCost) / notional) * 100).toFixed(4));
}
