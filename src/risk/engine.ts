import type { AppConfig } from '../config/env.js';
import { type Clock, systemClock } from '../core/clock.js';
import { createLogger, type Logger } from '../core/logger.js';
import { instrumentVerdict } from './instrument.js';
import { sizePosition } from './position-sizing.js';
import type { PortfolioSnapshot, RiskDecision, RiskRejection, RiskRequest } from './types.js';

/**
 * The Risk Engine.
 *
 * Independent of the LLM by construction: it takes numbers, applies rules in a
 * fixed order, and returns a decision. It cannot be argued with, and a
 * confident model has no more influence over it than an unconfident one — the
 * score enters only as a sizing input, bounded by the configured caps.
 *
 * Every check runs and is recorded even after the first failure, so the
 * decision log shows the complete picture rather than the first objection.
 *
 * Rule order is deliberate: halting conditions (which stop *all* trading)
 * are evaluated before per-order conditions, so an operator reading a
 * rejection sees the most serious reason first.
 */

export interface RiskEngineOptions {
  config: AppConfig;
  clock?: Clock;
  logger?: Logger;
  /** Minimum composite score before an order is considered at all. */
  minScore?: number;
  /** Minimum order value; below this, costs dominate. */
  minNotional?: number;
  allowFractionalShares?: boolean;
}

export class RiskEngine {
  private readonly config: AppConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly minScore: number;
  private readonly minNotional: number;
  private readonly allowFractional: boolean;

  /** Client order ids already seen, for duplicate-order protection. */
  private readonly seenOrderIds = new Set<string>();

  constructor(options: RiskEngineOptions) {
    this.config = options.config;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('risk-engine');
    this.minScore = options.minScore ?? 0.55;
    this.minNotional = options.minNotional ?? 50;
    this.allowFractional = options.allowFractionalShares ?? true;
  }

  /**
   * Conditions that stop all trading, independent of any particular order.
   * Exposed separately so the worker can halt before generating signals.
   */
  haltingConditions(portfolio: PortfolioSnapshot): RiskRejection[] {
    const halts: RiskRejection[] = [];

    const dailyLossPercent =
      portfolio.dayStartValue > 0
        ? ((portfolio.dayStartValue - portfolio.totalValue) / portfolio.dayStartValue) * 100
        : 0;
    if (dailyLossPercent >= this.config.MAX_DAILY_LOSS_PERCENT) {
      halts.push({
        rule: 'max_daily_loss',
        message: `daily loss ${dailyLossPercent.toFixed(2)}% reached the ${this.config.MAX_DAILY_LOSS_PERCENT}% limit — trading halted for today`,
        halting: true,
      });
    }

    if (portfolio.tradesToday >= this.config.MAX_TRADES_PER_DAY) {
      halts.push({
        rule: 'max_trades_per_day',
        message: `${portfolio.tradesToday} trades today reached the limit of ${this.config.MAX_TRADES_PER_DAY}`,
        halting: true,
      });
    }

    // A cooldown after consecutive losses interrupts the pattern where a
    // strategy keeps firing into conditions it is currently wrong about.
    if (portfolio.consecutiveLosses >= 3 && portfolio.lastLossAt) {
      const minutesSince = (this.clock.nowMs() - Date.parse(portfolio.lastLossAt)) / 60_000;
      if (minutesSince < this.config.CONSECUTIVE_LOSS_COOLDOWN_MINUTES) {
        halts.push({
          rule: 'consecutive_loss_cooldown',
          message: `${portfolio.consecutiveLosses} consecutive losses — cooling down for another ${Math.ceil(this.config.CONSECUTIVE_LOSS_COOLDOWN_MINUTES - minutesSince)} minutes`,
          halting: true,
        });
      }
    }

    return halts;
  }

  evaluate(request: RiskRequest, portfolio: PortfolioSnapshot): RiskDecision {
    const checks: RiskDecision['checks'] = [];
    const rejections: RiskRejection[] = [];
    const decidedAt = this.clock.now().toISOString();

    const check = (rule: string, passed: boolean, detail: string, halting = false) => {
      checks.push({ rule, passed, detail });
      if (!passed) rejections.push({ rule, message: detail, halting });
    };

    const side: 'buy' | 'sell' = request.action === 'SELL' ? 'sell' : 'buy';
    const reject = (): RiskDecision => ({
      verdict: 'rejected',
      quantity: 0,
      notional: 0,
      symbol: request.symbol,
      side,
      checks,
      rejections,
      decidedAt,
    });

    // --- Halting conditions first ---------------------------------------
    for (const halt of this.haltingConditions(portfolio)) {
      checks.push({ rule: halt.rule, passed: false, detail: halt.message });
      rejections.push(halt);
    }

    // --- Mode and instrument permissions ---------------------------------
    check(
      'trading_mode',
      this.config.MODE !== 'backtest',
      `mode is ${this.config.MODE}`,
    );

    if (this.config.isLive) {
      check(
        'asset_allowlist',
        this.config.ALLOWED_ASSETS.includes(request.symbol),
        `${request.symbol} ${this.config.ALLOWED_ASSETS.includes(request.symbol) ? 'is' : 'is NOT'} on the live allowlist`,
      );
    } else {
      checks.push({
        rule: 'asset_allowlist',
        passed: true,
        detail: 'not enforced outside live mode',
      });
    }

    // Enforced in every mode, not only live: paper results that include trades
    // the real configuration forbids measure a system nobody is allowed to run.
    const instrument = instrumentVerdict(request.symbol, this.config);
    check('instrument_permitted', instrument.permitted, instrument.detail);

    check(
      'direction_permitted',
      side === 'buy' || this.config.ALLOW_SHORT_SELLING || this.hasPosition(portfolio, request.symbol),
      side === 'sell' && !this.config.ALLOW_SHORT_SELLING
        ? 'selling without an existing position requires ALLOW_SHORT_SELLING=true'
        : `${side} permitted`,
    );

    // --- Data quality ----------------------------------------------------
    check(
      'price_freshness',
      request.priceAgeSeconds <= this.config.MAX_QUOTE_STALENESS_SECONDS,
      `quote is ${Math.round(request.priceAgeSeconds)}s old (limit ${this.config.MAX_QUOTE_STALENESS_SECONDS}s)`,
    );
    check('price_sane', request.price > 0 && Number.isFinite(request.price), `price=${request.price}`);

    // --- Signal quality --------------------------------------------------
    check(
      'min_score',
      request.score >= this.minScore,
      `score ${request.score.toFixed(3)} vs minimum ${this.minScore}`,
    );
    check(
      'actionable_direction',
      request.action === 'BUY' || request.action === 'SELL',
      `action is ${request.action}`,
    );

    // --- Duplicate protection --------------------------------------------
    check(
      'duplicate_order',
      !this.seenOrderIds.has(request.clientOrderId),
      this.seenOrderIds.has(request.clientOrderId)
        ? `client order id ${request.clientOrderId} was already submitted`
        : 'client order id is new',
    );

    if (rejections.length > 0) {
      this.log.info(
        { symbol: request.symbol, rules: rejections.map((r) => r.rule) },
        'order rejected by risk engine',
      );
      return reject();
    }

    // --- Sizing ----------------------------------------------------------
    const sizing = sizePosition({
      portfolioValue: portfolio.totalValue,
      price: request.price,
      maxSingleTradeRiskPercent: this.config.MAX_SINGLE_TRADE_RISK_PERCENT,
      maxPositionPercent: this.config.MAX_POSITION_PERCENT,
      score: request.score,
      ...(request.volatilityPct !== undefined ? { volatilityPct: request.volatilityPct } : {}),
      allowFractional: this.allowFractional,
    });

    check(
      'position_sizeable',
      sizing.quantity > 0,
      sizing.quantity > 0
        ? `${sizing.quantity} units, risking ${sizing.riskPercent}% of portfolio`
        : 'computed size is zero — portfolio too small for this price',
    );
    check(
      'min_notional',
      sizing.notional >= this.minNotional,
      `order value ${sizing.notional} vs minimum ${this.minNotional} (below this, costs dominate)`,
    );

    // --- Portfolio-level exposure ----------------------------------------
    const existing = this.positionValue(portfolio, request.symbol);
    const projectedPositionPct =
      portfolio.totalValue > 0 ? ((existing + sizing.notional) / portfolio.totalValue) * 100 : 100;
    check(
      'max_position',
      projectedPositionPct <= this.config.MAX_POSITION_PERCENT,
      `position would be ${projectedPositionPct.toFixed(1)}% of portfolio (limit ${this.config.MAX_POSITION_PERCENT}%)`,
    );

    const currentExposure = portfolio.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
    const projectedExposurePct =
      portfolio.totalValue > 0 ? ((currentExposure + sizing.notional) / portfolio.totalValue) * 100 : 100;
    check(
      'max_portfolio_exposure',
      projectedExposurePct <= this.config.MAX_PORTFOLIO_EXPOSURE_PERCENT,
      `exposure would be ${projectedExposurePct.toFixed(1)}% (limit ${this.config.MAX_PORTFOLIO_EXPOSURE_PERCENT}%)`,
    );

    if (request.correlationGroup) {
      const groupValue = portfolio.positions
        .filter((p) => p.correlationGroup === request.correlationGroup)
        .reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
      const projectedGroupPct =
        portfolio.totalValue > 0 ? ((groupValue + sizing.notional) / portfolio.totalValue) * 100 : 100;
      check(
        'max_correlated_exposure',
        projectedGroupPct <= this.config.MAX_CORRELATED_EXPOSURE_PERCENT,
        `"${request.correlationGroup}" exposure would be ${projectedGroupPct.toFixed(1)}% (limit ${this.config.MAX_CORRELATED_EXPOSURE_PERCENT}%)`,
      );
    }

    check(
      'sufficient_cash',
      side === 'sell' || sizing.notional <= portfolio.cash,
      `order value ${sizing.notional} vs cash ${portfolio.cash.toFixed(2)}`,
    );

    if (rejections.length > 0) {
      this.log.info(
        { symbol: request.symbol, rules: rejections.map((r) => r.rule) },
        'order rejected by risk engine',
      );
      return reject();
    }

    // Only now is the id consumed — a rejected order should not burn its own
    // idempotency key, or a corrected retry would be refused as a duplicate.
    this.seenOrderIds.add(request.clientOrderId);

    return {
      verdict: 'approved',
      quantity: sizing.quantity,
      notional: sizing.notional,
      symbol: request.symbol,
      side,
      checks,
      rejections: [],
      stopPrice: sizing.stopPrice,
      riskPercent: sizing.riskPercent,
      decidedAt,
    };
  }

  private hasPosition(portfolio: PortfolioSnapshot, symbol: string): boolean {
    return portfolio.positions.some((p) => p.symbol === symbol && p.quantity > 0);
  }

  private positionValue(portfolio: PortfolioSnapshot, symbol: string): number {
    return portfolio.positions
      .filter((p) => p.symbol === symbol)
      .reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  }

  /** Test/ops helper: forget submitted order ids. */
  resetOrderHistory(): void {
    this.seenOrderIds.clear();
  }

  /** Submitted order ids, so duplicate protection can survive a restart. */
  get submittedOrderIds(): string[] {
    return [...this.seenOrderIds];
  }

  /**
   * Re-seed duplicate protection from persisted state.
   *
   * Without this, a restart makes every previously submitted order id look
   * fresh, and a replayed signal places the same order twice.
   */
  rememberOrderIds(ids: Iterable<string>): void {
    for (const id of ids) this.seenOrderIds.add(id);
  }
}
