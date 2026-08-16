import type { Bar } from '../domain/types.js';
import { runBacktest, type BacktestStrategy, type BacktestOptions } from './engine.js';
import { computeMetrics, type EquityPoint, type PerformanceMetrics, type TradeRecord } from './metrics.js';

/**
 * Walk-forward validation.
 *
 * Fitting and testing on the same period tells you how well a strategy
 * describes the past, which is a question nobody needs answered. Walk-forward
 * splits the data into rolling train/test windows and reports only the
 * out-of-sample results:
 *
 *   train 2020-2022 -> test 2023
 *   train 2021-2023 -> test 2024
 *   train 2022-2024 -> test 2025
 *
 * A `buildStrategy` callback receives the training window and returns a
 * configured strategy. Whatever it fits, it fits on training data only — the
 * test window is not passed to it, so it cannot be peeked at.
 */

export interface WalkForwardWindow {
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  trainBars: number;
  testBars: number;
  metrics: PerformanceMetrics;
  trades: TradeRecord[];
}

export interface WalkForwardResult {
  strategyId: string;
  symbol: string;
  windows: WalkForwardWindow[];
  /** Metrics over the concatenated out-of-sample equity curve. */
  aggregate: PerformanceMetrics;
  /** How consistent the windows were — high variance means an unstable edge. */
  consistency: {
    profitableWindows: number;
    totalWindows: number;
    meanReturnPct: number;
    returnStdDevPct: number;
  };
}

export interface WalkForwardOptions {
  bars: Bar[];
  /** Called once per window with the training slice only. */
  buildStrategy: (trainingBars: Bar[]) => BacktestStrategy;
  initialCapital: number;
  /** Bars in each training window. */
  trainBars?: number;
  /** Bars in each test window. */
  testBars?: number;
  /** Bars to advance between windows. Defaults to the test window length. */
  stepBars?: number;
  backtestOptions?: Partial<Omit<BacktestOptions, 'bars' | 'strategy' | 'initialCapital'>>;
}

export function runWalkForward(options: WalkForwardOptions): WalkForwardResult {
  const bars = [...options.bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const trainSize = options.trainBars ?? 504; // ~2 years of daily bars
  const testSize = options.testBars ?? 252; // ~1 year
  const step = options.stepBars ?? testSize;

  if (bars.length < trainSize + testSize) {
    throw new Error(
      `Not enough bars for walk-forward: need ${trainSize + testSize}, received ${bars.length}`,
    );
  }

  const windows: WalkForwardWindow[] = [];
  const combinedCurve: EquityPoint[] = [];
  const combinedTrades: TradeRecord[] = [];
  let carriedCapital = options.initialCapital;

  for (let start = 0; start + trainSize + testSize <= bars.length; start += step) {
    const trainingBars = bars.slice(start, start + trainSize);
    const testBars = bars.slice(start + trainSize, start + trainSize + testSize);

    // The strategy is built from training data only. The test slice is not in
    // scope here, which is what makes the result out-of-sample.
    const strategy = options.buildStrategy(trainingBars);

    // Warmup bars are prepended from the training window so the strategy has
    // history without seeing test data before its first decision.
    const warmup = bars.slice(
      Math.max(0, start + trainSize - strategy.warmupBars),
      start + trainSize,
    );

    const result = runBacktest({
      ...options.backtestOptions,
      bars: [...warmup, ...testBars],
      strategy,
      initialCapital: carriedCapital,
    });

    windows.push({
      trainFrom: trainingBars[0]!.timestamp,
      trainTo: trainingBars[trainingBars.length - 1]!.timestamp,
      testFrom: testBars[0]!.timestamp,
      testTo: testBars[testBars.length - 1]!.timestamp,
      trainBars: trainingBars.length,
      testBars: testBars.length,
      metrics: result.metrics,
      trades: result.trades,
    });

    combinedCurve.push(...result.equityCurve);
    combinedTrades.push(...result.trades);
    // Compounding across windows reflects how the strategy would actually have
    // been run, rather than restarting at the initial capital each year.
    carriedCapital = result.equityCurve[result.equityCurve.length - 1]?.value ?? carriedCapital;
  }

  const returns = windows.map((w) => w.metrics.totalReturnPct);
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (returns.length - 1)
      : 0;

  return {
    strategyId: windows.length > 0 ? 'walk-forward' : 'none',
    symbol: bars[0]!.symbol,
    windows,
    aggregate: computeMetrics(combinedCurve, combinedTrades),
    consistency: {
      profitableWindows: windows.filter((w) => w.metrics.totalReturnPct > 0).length,
      totalWindows: windows.length,
      meanReturnPct: Number(meanReturn.toFixed(3)),
      returnStdDevPct: Number(Math.sqrt(variance).toFixed(3)),
    },
  };
}
