#!/usr/bin/env tsx
import { loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';
import type { Bar } from '../src/domain/types.js';
import { buildIngestionStack } from '../src/ingestion/pipeline.js';
import { runBacktest } from '../src/backtesting/engine.js';
import { runWalkForward } from '../src/backtesting/walk-forward.js';
import { BuyAndHoldStrategy, MovingAverageCrossStrategy } from '../src/backtesting/strategies.js';
import type { PerformanceMetrics } from '../src/backtesting/metrics.js';

/**
 * Backtesting CLI.
 *
 *   npm run backtest -- --symbol AAPL --years 5
 *   npm run backtest -- --symbol AAPL --walk-forward
 *   npm run backtest -- --symbol AAPL --benner        (falsification test)
 *
 * Reports everything net of costs, always alongside buy & hold, and refuses to
 * present a result as meaningful when the sample cannot support it.
 */

loadEnvFile();
const config = loadConfig();

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const symbol = (flag('symbol') ?? config.WATCHLIST[0] ?? 'AAPL').toUpperCase();
const years = Number(flag('years') ?? 5);
const useFixture = has('fixture');

const stack = buildIngestionStack(config, { includeFixtureMarketData: useFixture });

const start = new Date(Date.now() - years * 365.25 * 86_400_000);
console.log(`\nFetching daily bars for ${symbol} since ${start.toISOString().slice(0, 10)}...`);

let bars: Bar[];
let provider: string;
try {
  const result = await stack.marketData.getBars(symbol, '1Day', { start });
  bars = result.bars;
  provider = result.provider;
} catch (err) {
  console.error(`\nCannot backtest: ${(err as Error).message}`);
  console.error(
    '\nNo configured market data provider returned history. Add a provider key, or pass --fixture ' +
      'to run against SYNTHETIC data (which measures nothing about the real market).\n',
  );
  process.exit(1);
}

if (useFixture) {
  console.log('\n*** SYNTHETIC DATA — these results describe a random walk, not any market. ***');
}
console.log(`  ${bars.length} bars from ${provider}\n`);

function report(label: string, metrics: PerformanceMetrics): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  total return           ${metrics.totalReturnPct}%`);
  console.log(`  annualised return      ${metrics.annualisedReturnPct}%`);
  console.log(`  volatility             ${metrics.volatilityPct}%`);
  console.log(`  Sharpe                 ${metrics.sharpeRatio}`);
  console.log(`  Sortino                ${metrics.sortinoRatio}`);
  console.log(`  max drawdown           ${metrics.maxDrawdownPct}%`);
  console.log(`  win rate               ${(metrics.winRate * 100).toFixed(1)}%`);
  console.log(`  profit factor          ${metrics.profitFactor}`);
  console.log(`  average trade          ${metrics.averageTradePnl}`);
  console.log(`  number of trades       ${metrics.numberOfTrades}`);
  console.log(`  total costs            ${metrics.totalCosts} (${metrics.costDragPct}% of capital)`);
  if (metrics.buyAndHoldReturnPct !== undefined) {
    console.log(`  buy & hold             ${metrics.buyAndHoldReturnPct}%`);
    console.log(`  excess over buy & hold ${metrics.excessOverBuyAndHoldPct}%`);
  }
  console.log(`  Sharpe t-stat          ${metrics.sharpeTStat}`);
  if (metrics.statisticalWarning) {
    console.log(`\n  !! ${metrics.statisticalWarning}`);
  }
}

const capital = config.PAPER_CAPITAL_EUR;
console.log(`Capital: ${capital} ${config.BASE_CURRENCY}`);

if (has('walk-forward')) {
  console.log('\nRunning walk-forward validation (out-of-sample only)...');
  const result = runWalkForward({
    bars,
    initialCapital: capital,
    buildStrategy: () => new MovingAverageCrossStrategy(),
    trainBars: Number(flag('train') ?? 504),
    testBars: Number(flag('test') ?? 252),
  });

  for (const window of result.windows) {
    console.log(
      `\n  train ${window.trainFrom.slice(0, 10)}..${window.trainTo.slice(0, 10)} -> ` +
        `test ${window.testFrom.slice(0, 10)}..${window.testTo.slice(0, 10)}: ` +
        `${window.metrics.totalReturnPct}% (${window.metrics.numberOfTrades} trades)`,
    );
  }
  console.log(
    `\n  ${result.consistency.profitableWindows}/${result.consistency.totalWindows} windows profitable, ` +
      `mean ${result.consistency.meanReturnPct}% ± ${result.consistency.returnStdDevPct}%`,
  );
  report('Walk-forward aggregate (out of sample)', result.aggregate);
} else if (has('benner')) {
  // The falsification test the brief asks for: identical logic, one difference.
  console.log('\nBenner cycle falsification test — identical strategy, weight 0 vs 0.5.\n');
  const without = runBacktest({
    bars,
    strategy: new MovingAverageCrossStrategy({ benner: { weight: 0 } }),
    initialCapital: capital,
  });
  const with_ = runBacktest({
    bars,
    strategy: new MovingAverageCrossStrategy({ benner: { weight: 0.5, includeAdjacentYears: true } }),
    initialCapital: capital,
  });

  report('WITHOUT Benner', without.metrics);
  report('WITH Benner (weight 0.5)', with_.metrics);

  const delta = with_.metrics.totalReturnPct - without.metrics.totalReturnPct;
  const sharpeDelta = with_.metrics.sharpeRatio - without.metrics.sharpeRatio;
  console.log(`\n=== Verdict ===`);
  console.log(`  return difference      ${delta.toFixed(3)} percentage points`);
  console.log(`  Sharpe difference      ${sharpeDelta.toFixed(3)}`);
  console.log(
    sharpeDelta > 0.2
      ? '\n  Benner appears to help on THIS sample. One in-sample result is not evidence —\n' +
          '  re-run with --walk-forward before drawing any conclusion.'
      : '\n  No improvement. On this evidence the Benner cycle should stay at weight zero,\n' +
          '  and the code should be deleted rather than left dormant.',
  );
} else {
  const active = new MovingAverageCrossStrategy();
  const strategy = runBacktest({ bars, strategy: active, initialCapital: capital });
  // Same warmup, so both runs cover exactly the same period and the comparison
  // is between strategies rather than between date ranges.
  const baseline = runBacktest({
    bars,
    strategy: new BuyAndHoldStrategy(active.warmupBars),
    initialCapital: capital,
  });

  report(`Strategy: ${strategy.strategyId}`, strategy.metrics);
  report('Baseline: buy & hold', baseline.metrics);

  console.log('\n=== Comparison ===');
  console.log(
    `  The strategy ${strategy.metrics.totalReturnPct > baseline.metrics.totalReturnPct ? 'beat' : 'did NOT beat'} ` +
      `buy & hold by ${(strategy.metrics.totalReturnPct - baseline.metrics.totalReturnPct).toFixed(2)} percentage points, ` +
      `net of ${strategy.metrics.totalCosts} in costs.`,
  );
}

console.log('');
