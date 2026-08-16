import type { BacktestStrategy, StrategyContext, StrategyDecision } from './engine.js';
import { simpleMovingAverage } from '../strategy/regime.js';
import { applyBennerTilt, bennerSignal, type BennerOptions } from '../strategy/signals/benner.js';

/**
 * Reference strategies for validating the engine and providing a baseline.
 *
 * These are **not** the LLM strategy. Their purpose is to give the backtester
 * something deterministic to run against, and to provide the honest comparison
 * every result needs: a strategy that cannot beat buy & hold after costs has
 * not demonstrated anything.
 */

/**
 * Does nothing. The floor any strategy must clear.
 *
 * `warmupBars` is configurable so the baseline can be aligned to the strategy
 * it is compared against — comparing two runs that cover different periods
 * would make the comparison meaningless.
 */
export class BuyAndHoldStrategy implements BacktestStrategy {
  readonly id = 'buy_and_hold';
  readonly warmupBars: number;

  constructor(warmupBars = 1) {
    this.warmupBars = warmupBars;
  }

  decide(context: StrategyContext): StrategyDecision {
    if (context.positionQuantity === 0) {
      return { action: 'buy', sizeFraction: 1, reason: 'initial entry' };
    }
    return { action: 'hold' };
  }
}

export interface MovingAverageOptions {
  fastPeriod?: number;
  slowPeriod?: number;
  sizeFraction?: number;
  /** Benner tilt configuration. Default weight is zero. */
  benner?: BennerOptions;
}

/**
 * Moving-average crossover, optionally tilted by the Benner cycle.
 *
 * The Benner hook exists so the with/without comparison can be run on
 * identical logic — the only difference between the two arms is the weight.
 */
export class MovingAverageCrossStrategy implements BacktestStrategy {
  readonly id: string;
  readonly warmupBars: number;

  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly sizeFraction: number;
  private readonly benner: BennerOptions;

  constructor(options: MovingAverageOptions = {}) {
    this.fastPeriod = options.fastPeriod ?? 20;
    this.slowPeriod = options.slowPeriod ?? 50;
    this.sizeFraction = options.sizeFraction ?? 0.95;
    this.benner = options.benner ?? { weight: 0 };
    this.warmupBars = this.slowPeriod + 1;
    this.id = `ma_${this.fastPeriod}_${this.slowPeriod}${(this.benner.weight ?? 0) > 0 ? `_benner${this.benner.weight}` : ''}`;
  }

  decide(context: StrategyContext): StrategyDecision {
    const fast = simpleMovingAverage(context.history, this.fastPeriod);
    const slow = simpleMovingAverage(context.history, this.slowPeriod);
    if (fast === undefined || slow === undefined) return { action: 'hold' };

    // Raw conviction in [0,1] from the separation between the averages.
    const separation = slow > 0 ? (fast - slow) / slow : 0;
    let conviction = Math.max(0, Math.min(1, separation * 20));

    const benner = bennerSignal(new Date(context.today.timestamp), this.benner);
    conviction = applyBennerTilt(conviction, benner);

    const bullish = fast > slow;

    if (bullish && context.positionQuantity === 0 && conviction > 0.15) {
      return {
        action: 'buy',
        sizeFraction: this.sizeFraction * conviction,
        reason: `fast MA above slow MA (separation ${(separation * 100).toFixed(2)}%)${benner.weight > 0 ? `, benner ${benner.phase}` : ''}`,
      };
    }
    if (!bullish && context.positionQuantity > 0) {
      return { action: 'sell', reason: 'fast MA crossed below slow MA' };
    }
    return { action: 'hold' };
  }
}
