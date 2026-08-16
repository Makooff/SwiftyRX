import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import type { Bar } from '../src/domain/types.js';
import { DEFAULT_COST_MODEL, ZERO_COST_MODEL, estimateFill, roundTripCostPercent } from '../src/execution/costs.js';
import { Portfolio } from '../src/execution/paper/portfolio.js';
import { PaperBroker } from '../src/execution/paper/paper-broker.js';
import { BrokerRejectionError, DuplicateOrderError } from '../src/execution/broker/types.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { runBacktest } from '../src/backtesting/engine.js';
import { runWalkForward } from '../src/backtesting/walk-forward.js';
import { BuyAndHoldStrategy, MovingAverageCrossStrategy } from '../src/backtesting/strategies.js';
import { computeMetrics, maxDrawdownPct } from '../src/backtesting/metrics.js';
import type { BacktestStrategy, StrategyContext, StrategyDecision } from '../src/backtesting/engine.js';

const clock = FixedClock.at('2026-08-16T12:00:00Z');

function makeBars(closes: number[], symbol = 'TEST'): Bar[] {
  return closes.map((close, index) => {
    const timestamp = new Date(Date.UTC(2024, 0, 1 + index)).toISOString();
    return {
      symbol,
      timestamp,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
      interval: '1Day' as const,
      freshness: { asOf: timestamp, retrievedAt: timestamp, delayClass: 'end_of_day' as const, feed: 'test' },
    };
  });
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

describe('cost model', () => {
  it('always fills against the trade', () => {
    const buy = estimateFill(100, 10, 'buy');
    const sell = estimateFill(100, 10, 'sell');
    expect(buy.fillPrice).toBeGreaterThan(100);
    expect(sell.fillPrice).toBeLessThan(100);
  });

  it('charges commission and slippage separately', () => {
    const fill = estimateFill(100, 10, 'buy', DEFAULT_COST_MODEL);
    expect(fill.commission).toBeGreaterThan(0);
    expect(fill.slippage).toBeGreaterThan(0);
    expect(fill.totalCost).toBeCloseTo(fill.commission + fill.slippage, 2);
  });

  it('shows why small orders cannot work', () => {
    // A €50 order paying a €1 commission each way starts 4% behind.
    const small = roundTripCostPercent(10, 5);
    const large = roundTripCostPercent(10, 1000);
    expect(small).toBeGreaterThan(large * 5);
    expect(small).toBeGreaterThan(2);
  });

  it('supports a zero-cost model for isolating strategy behaviour', () => {
    const fill = estimateFill(100, 10, 'buy', ZERO_COST_MODEL);
    expect(fill.fillPrice).toBe(100);
    expect(fill.totalCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

describe('Portfolio', () => {
  it('tracks cash, positions and value through a round trip', () => {
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    portfolio.applyBuy('AAPL', 10, 100, 1);
    expect(portfolio.availableCash).toBeCloseTo(8_999, 1);
    expect(portfolio.openPositions).toHaveLength(1);

    portfolio.mark('AAPL', 110);
    expect(portfolio.totalValue).toBeGreaterThan(10_000);

    const trade = portfolio.applySell('AAPL', 10, 110, 1);
    expect(trade!.realisedPnl).toBeGreaterThan(0);
    expect(portfolio.openPositions).toHaveLength(0);
  });

  it('capitalises commission into the average price so break-even is honest', () => {
    const portfolio = new Portfolio({ initialCash: 1_000, clock });
    portfolio.applyBuy('X', 10, 10, 5);
    expect(portfolio.openPositions[0]!.averagePrice).toBeGreaterThan(10);
  });

  it('records drawdown as prominently as gains', () => {
    const portfolio = new Portfolio({ initialCash: 1_000, clock });
    portfolio.applyBuy('X', 10, 100, 0);
    portfolio.mark('X', 120);
    portfolio.mark('X', 60);
    expect(portfolio.maxDrawdown).toBeGreaterThan(40);
    expect(portfolio.totalReturnPct).toBeLessThan(0);
  });

  it('counts consecutive losses for the risk cooldown', () => {
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    for (let i = 0; i < 3; i++) {
      portfolio.applyBuy('X', 10, 100, 0);
      portfolio.applySell('X', 10, 90, 0);
    }
    expect(portfolio.snapshot().consecutiveLosses).toBe(3);
    expect(portfolio.snapshot().lastLossAt).toBeDefined();
  });

  it('resets the loss streak after a win', () => {
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    portfolio.applyBuy('X', 10, 100, 0);
    portfolio.applySell('X', 10, 90, 0);
    portfolio.applyBuy('X', 10, 100, 0);
    portfolio.applySell('X', 10, 120, 0);
    expect(portfolio.snapshot().consecutiveLosses).toBe(0);
  });

  it('will not sell what it does not hold', () => {
    const portfolio = new Portfolio({ initialCash: 1_000, clock });
    expect(portfolio.applySell('X', 10, 100, 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Paper broker
// ---------------------------------------------------------------------------

function paperSetup() {
  const portfolio = new Portfolio({ initialCash: 100_000, clock });
  const marketData = new MarketDataService({
    providers: [new FixtureMarketDataAdapter({ clock, basePrices: { TEST: 100 } })],
    maxStalenessSeconds: 120,
    clock,
  });
  const broker = new PaperBroker({ portfolio, marketData, clock });
  return { portfolio, broker };
}

describe('PaperBroker', () => {
  it('is always a paper account', async () => {
    const { broker } = paperSetup();
    expect(broker.isPaper).toBe(true);
    expect((await broker.getAccount()).isPaper).toBe(true);
  });

  it('fills a buy with costs applied', async () => {
    const { broker, portfolio } = paperSetup();
    const order = await broker.placeOrder({
      symbol: 'TEST',
      side: 'buy',
      quantity: 10,
      type: 'market',
      clientOrderId: 'o1',
    });

    expect(order.status).toBe('filled');
    expect(order.commission).toBeGreaterThan(0);
    expect(order.slippage).toBeGreaterThan(0);
    expect(portfolio.openPositions).toHaveLength(1);
  });

  it('refuses a duplicate client order id', async () => {
    const { broker } = paperSetup();
    await broker.placeOrder({ symbol: 'TEST', side: 'buy', quantity: 1, type: 'market', clientOrderId: 'dup' });
    await expect(
      broker.placeOrder({ symbol: 'TEST', side: 'buy', quantity: 1, type: 'market', clientOrderId: 'dup' }),
    ).rejects.toThrow(DuplicateOrderError);
  });

  it('rejects selling more than it holds', async () => {
    const { broker } = paperSetup();
    await expect(
      broker.placeOrder({ symbol: 'TEST', side: 'sell', quantity: 5, type: 'market', clientOrderId: 'o2' }),
    ).rejects.toThrow(BrokerRejectionError);
  });

  it('rejects an order it cannot price rather than guessing', async () => {
    const portfolio = new Portfolio({ initialCash: 10_000, clock });
    const marketData = new MarketDataService({ providers: [], maxStalenessSeconds: 120, clock });
    const broker = new PaperBroker({ portfolio, marketData, clock });

    await expect(
      broker.placeOrder({ symbol: 'TEST', side: 'buy', quantity: 1, type: 'market', clientOrderId: 'o3' }),
    ).rejects.toThrow(/no usable quote/);
  });

  it('rejects a buy it cannot afford', async () => {
    const portfolio = new Portfolio({ initialCash: 50, clock });
    const marketData = new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { TEST: 100 } })],
      maxStalenessSeconds: 120,
      clock,
    });
    const broker = new PaperBroker({ portfolio, marketData, clock });

    await expect(
      broker.placeOrder({ symbol: 'TEST', side: 'buy', quantity: 10, type: 'market', clientOrderId: 'o4' }),
    ).rejects.toThrow(/insufficient cash/);
  });

  it('has no method that could move money out of the account', () => {
    const { broker } = paperSetup();
    for (const forbidden of ['withdraw', 'transfer', 'deposit', 'closeAccount', 'updateBankDetails']) {
      expect((broker as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('performance metrics', () => {
  it('computes drawdown from the peak', () => {
    expect(
      maxDrawdownPct([
        { date: 'a', value: 100 },
        { date: 'b', value: 150 },
        { date: 'c', value: 75 },
      ]),
    ).toBe(50);
  });

  it('warns when there are too few trades to conclude anything', () => {
    const metrics = computeMetrics(
      [
        { date: '2024-01-01T00:00:00Z', value: 1000 },
        { date: '2024-06-01T00:00:00Z', value: 1100 },
      ],
      [{ symbol: 'X', entryDate: 'a', exitDate: 'b', pnl: 100, returnPct: 10, costs: 2 }],
    );
    expect(metrics.statisticalWarning).toContain('too few');
  });

  it('reports a t-statistic alongside the Sharpe ratio', () => {
    const curve = Array.from({ length: 300 }, (_, i) => ({
      date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
      value: 1000 * (1 + i * 0.0005),
    }));
    const metrics = computeMetrics(curve, []);
    expect(metrics.sharpeTStat).toBeDefined();
  });

  it('does not report an infinite profit factor', () => {
    const metrics = computeMetrics(
      [
        { date: '2024-01-01T00:00:00Z', value: 1000 },
        { date: '2024-02-01T00:00:00Z', value: 1100 },
      ],
      [{ symbol: 'X', entryDate: 'a', exitDate: 'b', pnl: 100, returnPct: 10, costs: 1 }],
    );
    expect(Number.isFinite(metrics.profitFactor)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backtesting
// ---------------------------------------------------------------------------

/** Records the last bar it was allowed to see, to prove no look-ahead. */
class SpyStrategy implements BacktestStrategy {
  readonly id = 'spy';
  readonly warmupBars = 2;
  readonly seen: string[] = [];
  lastHistoryEnd?: string;

  decide(context: StrategyContext): StrategyDecision {
    this.seen.push(context.today.timestamp);
    this.lastHistoryEnd = context.history[context.history.length - 1]!.timestamp;
    return { action: 'hold' };
  }
}

describe('backtest engine', () => {
  it('never shows a strategy data beyond the current bar', () => {
    const spy = new SpyStrategy();
    const bars = makeBars([100, 101, 102, 103, 104, 105]);
    runBacktest({ bars, strategy: spy, initialCapital: 10_000 });

    // The last bar the strategy saw in history is always the current bar.
    expect(spy.lastHistoryEnd).toBe(spy.seen[spy.seen.length - 1]);
  });

  it('fills on the next bar, not the bar the decision was made on', () => {
    // The price doubles between day 1 and day 2. A strategy that decides on
    // day 1 must pay day 2's open (200), not day 1's close (100). Filling on
    // the decision bar would hand it a free ~100% gain it could never have had.
    const bars = makeBars([100, 200, 200, 200, 200]);
    const result = runBacktest({
      bars,
      strategy: new BuyAndHoldStrategy(1),
      initialCapital: 10_000,
      costModel: ZERO_COST_MODEL,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.returnPct).toBeCloseTo(0, 1);
    expect(result.metrics.totalReturnPct).toBeLessThan(1);
  });

  it('applies costs to every fill', () => {
    const bars = makeBars(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 10));
    const withCosts = runBacktest({
      bars,
      strategy: new MovingAverageCrossStrategy({ fastPeriod: 3, slowPeriod: 8 }),
      initialCapital: 10_000,
    });
    expect(withCosts.metrics.totalCosts).toBeGreaterThan(0);
  });

  it('reports buy & hold alongside every result', () => {
    const bars = makeBars(Array.from({ length: 60 }, (_, i) => 100 + i));
    const result = runBacktest({
      bars,
      strategy: new MovingAverageCrossStrategy({ fastPeriod: 3, slowPeriod: 8 }),
      initialCapital: 10_000,
    });
    expect(result.metrics.buyAndHoldReturnPct).toBeDefined();
    expect(result.metrics.excessOverBuyAndHoldPct).toBeDefined();
  });

  it('refuses to run without enough history', () => {
    expect(() =>
      runBacktest({ bars: makeBars([100, 101]), strategy: new MovingAverageCrossStrategy(), initialCapital: 1000 }),
    ).toThrow(/Not enough bars/);
  });

  it('closes any open position at the end so results are realised', () => {
    const bars = makeBars(Array.from({ length: 40 }, (_, i) => 100 + i));
    const result = runBacktest({
      bars,
      strategy: new BuyAndHoldStrategy(1),
      initialCapital: 10_000,
    });
    expect(result.trades.length).toBeGreaterThan(0);
  });
});

describe('walk-forward validation', () => {
  it('builds each strategy from training data only', () => {
    const bars = makeBars(Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 20) * 15));
    const trainingWindows: number[] = [];

    const result = runWalkForward({
      bars,
      initialCapital: 10_000,
      trainBars: 100,
      testBars: 50,
      buildStrategy: (training) => {
        trainingWindows.push(training.length);
        return new MovingAverageCrossStrategy({ fastPeriod: 5, slowPeriod: 20 });
      },
    });

    expect(result.windows.length).toBeGreaterThan(1);
    // Every window received exactly the training slice, never the test slice.
    expect(trainingWindows.every((n) => n === 100)).toBe(true);
  });

  it('keeps train and test windows disjoint and ordered', () => {
    const bars = makeBars(Array.from({ length: 400 }, (_, i) => 100 + i * 0.1));
    const result = runWalkForward({
      bars,
      initialCapital: 10_000,
      trainBars: 100,
      testBars: 50,
      buildStrategy: () => new MovingAverageCrossStrategy({ fastPeriod: 5, slowPeriod: 20 }),
    });

    for (const window of result.windows) {
      expect(Date.parse(window.testFrom)).toBeGreaterThan(Date.parse(window.trainTo));
    }
  });

  it('reports consistency across windows, not just the aggregate', () => {
    const bars = makeBars(Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 15) * 10));
    const result = runWalkForward({
      bars,
      initialCapital: 10_000,
      trainBars: 100,
      testBars: 50,
      buildStrategy: () => new MovingAverageCrossStrategy({ fastPeriod: 5, slowPeriod: 20 }),
    });

    expect(result.consistency.totalWindows).toBe(result.windows.length);
    expect(result.consistency.returnStdDevPct).toBeGreaterThanOrEqual(0);
  });

  it('refuses to run without enough data for one full window', () => {
    expect(() =>
      runWalkForward({
        bars: makeBars([100, 101, 102]),
        initialCapital: 1000,
        buildStrategy: () => new BuyAndHoldStrategy(),
      }),
    ).toThrow(/Not enough bars/);
  });
});
