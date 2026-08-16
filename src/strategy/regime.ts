import type { Bar } from '../domain/types.js';

/**
 * Market regime detection.
 *
 * Deliberately simple and explainable: trend from a moving-average
 * relationship, volatility from realised standard deviation of daily returns.
 * A more elaborate model would be easy to write and hard to trust; this one can
 * be checked by hand against a chart.
 *
 * The regime is context for scoring, not a signal in its own right.
 */

export interface MarketRegime {
  trend: 'bullish' | 'bearish' | 'neutral';
  volatility: 'low' | 'normal' | 'high';
  /** Annualised realised volatility, in percent. */
  volatilityPct: number;
  /** Distance of price from its long moving average, in percent. */
  distanceFromMeanPct: number;
  /** Bars used. Fewer than `minBars` yields an 'unknown-equivalent' neutral. */
  sampleSize: number;
}

const TRADING_DAYS_PER_YEAR = 252;

export function dailyReturns(bars: Bar[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1]!.close;
    const current = bars[i]!.close;
    if (previous > 0) returns.push(current / previous - 1);
  }
  return returns;
}

export function annualisedVolatilityPct(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

export function simpleMovingAverage(bars: Bar[], period: number): number | undefined {
  if (bars.length < period) return undefined;
  const window = bars.slice(-period);
  return window.reduce((sum, bar) => sum + bar.close, 0) / period;
}

export interface RegimeOptions {
  fastPeriod?: number;
  slowPeriod?: number;
  /** Below this many bars the regime is reported as neutral. */
  minBars?: number;
  lowVolatilityPct?: number;
  highVolatilityPct?: number;
}

export function detectRegime(bars: Bar[], options: RegimeOptions = {}): MarketRegime {
  const fastPeriod = options.fastPeriod ?? 20;
  const slowPeriod = options.slowPeriod ?? 100;
  const minBars = options.minBars ?? slowPeriod;
  const lowVol = options.lowVolatilityPct ?? 15;
  const highVol = options.highVolatilityPct ?? 35;

  const volatilityPct = annualisedVolatilityPct(dailyReturns(bars));

  if (bars.length < minBars) {
    // Not enough history to characterise the regime. Saying "neutral" is
    // honest; inventing a trend from 10 bars is not.
    return {
      trend: 'neutral',
      volatility: volatilityPct >= highVol ? 'high' : volatilityPct <= lowVol ? 'low' : 'normal',
      volatilityPct: Number(volatilityPct.toFixed(2)),
      distanceFromMeanPct: 0,
      sampleSize: bars.length,
    };
  }

  const fast = simpleMovingAverage(bars, fastPeriod)!;
  const slow = simpleMovingAverage(bars, slowPeriod)!;
  const last = bars[bars.length - 1]!.close;

  const separationPct = slow > 0 ? ((fast - slow) / slow) * 100 : 0;
  const trend: MarketRegime['trend'] =
    // A 1% band keeps a flat market from being labelled trending by noise.
    separationPct > 1 ? 'bullish' : separationPct < -1 ? 'bearish' : 'neutral';

  return {
    trend,
    volatility: volatilityPct >= highVol ? 'high' : volatilityPct <= lowVol ? 'low' : 'normal',
    volatilityPct: Number(volatilityPct.toFixed(2)),
    distanceFromMeanPct: Number((slow > 0 ? ((last - slow) / slow) * 100 : 0).toFixed(2)),
    sampleSize: bars.length,
  };
}
