import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig, LIVE_CONFIRMATION_PHRASE } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import { RiskEngine } from '../src/risk/engine.js';
import { sizePosition, stopDistancePct } from '../src/risk/position-sizing.js';
import type { PortfolioSnapshot, RiskRequest } from '../src/risk/types.js';
import { assertLiveTradingAllowed, createLiveBroker, LiveTradingBlockedError } from '../src/execution/live/live-broker.js';
import { AlpacaBroker } from '../src/execution/live/alpaca-broker.js';
import { BrokerRejectionError } from '../src/execution/broker/types.js';
import type { FetchImpl } from '../src/core/http.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';

/**
 * Risk Engine tests.
 *
 * These are the guardrails between a confident model and the account. Each one
 * describes a way money gets lost that the engine is supposed to prevent.
 */

const clock = FixedClock.at('2026-08-16T12:00:00Z');

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...overrides });
}

function portfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    cash: 10_000,
    currency: 'EUR',
    positions: [],
    totalValue: 10_000,
    dayStartValue: 10_000,
    peakValue: 10_000,
    realisedPnlToday: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
    ...overrides,
  };
}

function request(overrides: Partial<RiskRequest> = {}): RiskRequest {
  return {
    symbol: 'AAPL',
    action: 'BUY',
    score: 0.8,
    price: 200,
    priceAgeSeconds: 5,
    volatilityPct: 25,
    clientOrderId: `order-${Math.random()}`,
    ...overrides,
  };
}

describe('position sizing', () => {
  it('derives the stop distance from volatility, within bounds', () => {
    expect(stopDistancePct(undefined)).toBe(5);
    expect(stopDistancePct(16)).toBeGreaterThanOrEqual(2);
    expect(stopDistancePct(400)).toBeLessThanOrEqual(15);
  });

  it('sizes so that hitting the stop costs at most the risk budget', () => {
    const result = sizePosition({
      portfolioValue: 10_000,
      price: 100,
      maxSingleTradeRiskPercent: 1,
      maxPositionPercent: 20,
      score: 1,
      volatilityPct: 30,
    });
    expect(result.riskPercent).toBeLessThanOrEqual(1.001);
    expect(result.quantity).toBeGreaterThan(0);
  });

  it('never exceeds the position cap', () => {
    const result = sizePosition({
      portfolioValue: 10_000,
      price: 10,
      maxSingleTradeRiskPercent: 5,
      maxPositionPercent: 20,
      score: 1,
      volatilityPct: 5,
    });
    expect(result.notional).toBeLessThanOrEqual(2000.01);
    expect(result.boundBy).toBe('position_cap');
  });

  it('scales size with score but never above the cap', () => {
    const base = { portfolioValue: 10_000, maxSingleTradeRiskPercent: 1, maxPositionPercent: 50, price: 100 };
    const low = sizePosition({ ...base, score: 0.1, volatilityPct: 30 });
    const high = sizePosition({ ...base, score: 1, volatilityPct: 30 });
    expect(high.quantity).toBeGreaterThan(low.quantity);
    expect(high.riskPercent).toBeLessThanOrEqual(1.001);
  });

  it('returns zero rather than a fractional share when fractions are unavailable', () => {
    const result = sizePosition({
      portfolioValue: 300,
      price: 900,
      maxSingleTradeRiskPercent: 1,
      maxPositionPercent: 20,
      score: 1,
      allowFractional: false,
    });
    expect(result.quantity).toBe(0);
    expect(result.boundBy).toBe('price');
  });
});

describe('RiskEngine — halting conditions', () => {
  it('halts trading once the daily loss limit is reached', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const halts = engine.haltingConditions(portfolio({ totalValue: 9_700, dayStartValue: 10_000 }));
    expect(halts.map((h) => h.rule)).toContain('max_daily_loss');
  });

  it('halts once the daily trade count is reached', () => {
    const engine = new RiskEngine({ config: config({ MAX_TRADES_PER_DAY: '3' }), clock });
    expect(engine.haltingConditions(portfolio({ tradesToday: 3 })).map((h) => h.rule)).toContain(
      'max_trades_per_day',
    );
  });

  it('cools down after consecutive losses', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const halts = engine.haltingConditions(
      portfolio({ consecutiveLosses: 3, lastLossAt: '2026-08-16T11:30:00Z' }),
    );
    expect(halts.map((h) => h.rule)).toContain('consecutive_loss_cooldown');
  });

  it('resumes trading once the cooldown has elapsed', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const halts = engine.haltingConditions(
      portfolio({ consecutiveLosses: 3, lastLossAt: '2026-08-16T06:00:00Z' }),
    );
    expect(halts.map((h) => h.rule)).not.toContain('consecutive_loss_cooldown');
  });
});

describe('RiskEngine — per-order rules', () => {
  it('approves a well-formed order', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request(), portfolio());
    expect(decision.verdict).toBe('approved');
    expect(decision.quantity).toBeGreaterThan(0);
    expect(decision.stopPrice).toBeLessThan(200);
  });

  it('rejects a stale price — DO NOT TRADE', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request({ priceAgeSeconds: 600 }), portfolio());
    expect(decision.verdict).toBe('rejected');
    expect(decision.rejections.map((r) => r.rule)).toContain('price_freshness');
  });

  it('rejects a low-scoring signal', () => {
    const engine = new RiskEngine({ config: config(), clock, minScore: 0.6 });
    const decision = engine.evaluate(request({ score: 0.4 }), portfolio());
    expect(decision.rejections.map((r) => r.rule)).toContain('min_score');
  });

  it('rejects non-directional actions', () => {
    const engine = new RiskEngine({ config: config(), clock });
    for (const action of ['HOLD', 'WATCH'] as const) {
      expect(engine.evaluate(request({ action }), portfolio()).verdict).toBe('rejected');
    }
  });

  it('overrides a maximally confident signal when a limit is breached', () => {
    // The single most important property: a perfect score does not buy an
    // exception to any rule.
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(
      request({ score: 1, priceAgeSeconds: 9999 }),
      portfolio({ totalValue: 9_000, dayStartValue: 10_000 }),
    );
    expect(decision.verdict).toBe('rejected');
    expect(decision.quantity).toBe(0);
  });

  it('rejects a duplicate client order id', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const req = request({ clientOrderId: 'fixed-id' });
    expect(engine.evaluate(req, portfolio()).verdict).toBe('approved');
    const second = engine.evaluate(req, portfolio());
    expect(second.rejections.map((r) => r.rule)).toContain('duplicate_order');
  });

  it('does not consume the order id when the order is rejected', () => {
    // Otherwise a corrected retry would be refused as a duplicate.
    const engine = new RiskEngine({ config: config(), clock });
    const id = 'retry-me';
    expect(engine.evaluate(request({ clientOrderId: id, score: 0.1 }), portfolio()).verdict).toBe(
      'rejected',
    );
    expect(engine.evaluate(request({ clientOrderId: id, score: 0.9 }), portfolio()).verdict).toBe(
      'approved',
    );
  });

  it('rejects short selling unless explicitly enabled', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request({ action: 'SELL' }), portfolio());
    expect(decision.rejections.map((r) => r.rule)).toContain('direction_permitted');
  });

  it('allows selling a position that is actually held', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const held = portfolio({
      positions: [
        {
          symbol: 'AAPL',
          quantity: 10,
          averagePrice: 180,
          currency: 'EUR',
          marketValue: 2000,
          unrealisedPnl: 200,
          openedAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const decision = engine.evaluate(request({ action: 'SELL' }), held);
    expect(decision.checks.find((c) => c.rule === 'direction_permitted')?.passed).toBe(true);
  });

  it('enforces the maximum portfolio exposure', () => {
    const engine = new RiskEngine({ config: config({ MAX_PORTFOLIO_EXPOSURE_PERCENT: '30' }), clock });
    const loaded = portfolio({
      cash: 2_000,
      positions: [
        {
          symbol: 'MSFT',
          quantity: 20,
          averagePrice: 400,
          currency: 'EUR',
          marketValue: 8_000,
          unrealisedPnl: 0,
          openedAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const decision = engine.evaluate(request(), loaded);
    expect(decision.rejections.map((r) => r.rule)).toContain('max_portfolio_exposure');
  });

  it('enforces correlated exposure limits', () => {
    const engine = new RiskEngine({ config: config({ MAX_CORRELATED_EXPOSURE_PERCENT: '10' }), clock });
    const concentrated = portfolio({
      positions: [
        {
          symbol: 'NVDA',
          quantity: 5,
          averagePrice: 200,
          currency: 'EUR',
          marketValue: 1_000,
          unrealisedPnl: 0,
          openedAt: '2026-08-01T00:00:00Z',
          correlationGroup: 'semiconductors',
        },
      ],
    });
    const decision = engine.evaluate(
      request({ symbol: 'AMD', correlationGroup: 'semiconductors' }),
      concentrated,
    );
    expect(decision.rejections.map((r) => r.rule)).toContain('max_correlated_exposure');
  });

  it('rejects an order larger than available cash', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request(), portfolio({ cash: 10 }));
    expect(decision.rejections.map((r) => r.rule)).toContain('sufficient_cash');
  });

  it('rejects orders too small to survive costs', () => {
    const engine = new RiskEngine({ config: config(), clock, minNotional: 500 });
    const decision = engine.evaluate(
      // dayStartValue matches totalValue: this is a small account, not an
      // account that just lost 99% (which would halt trading first).
      request({ price: 5 }),
      portfolio({ cash: 100, totalValue: 100, dayStartValue: 100, peakValue: 100 }),
    );
    expect(decision.rejections.map((r) => r.rule)).toContain('min_notional');
  });

  it('enforces the live allowlist in live mode', () => {
    const liveConfig = config({
      MODE: 'live',
      LIVE_TRADING: 'true',
      PAPER_TRADING: 'false',
      LIVE_TRADING_CONFIRMATION: LIVE_CONFIRMATION_PHRASE,
      ALLOWED_ASSETS: 'MSFT',
    });
    const engine = new RiskEngine({ config: liveConfig, clock });
    const decision = engine.evaluate(request({ symbol: 'AAPL' }), portfolio());
    expect(decision.rejections.map((r) => r.rule)).toContain('asset_allowlist');
  });

  it('records every check that ran, not just the first failure', () => {
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request({ priceAgeSeconds: 9999, score: 0.1 }), portfolio());
    expect(decision.checks.length).toBeGreaterThan(4);
    expect(decision.rejections.length).toBeGreaterThan(1);
  });
});

describe('RiskEngine — instrument permissions', () => {
  it('refuses a memecoin pair with the default configuration', () => {
    // The default .env promises crypto is off. Before the gate existed the
    // promise was decorative: this order was sized and approved.
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request({ symbol: 'DOGE/USD' }), portfolio());
    expect(decision.verdict).toBe('rejected');
    expect(decision.rejections.map((r) => r.rule)).toContain('instrument_permitted');
  });

  it('enforces it in paper mode, not only live', () => {
    // Paper results that include trades the real configuration forbids measure
    // a system nobody is allowed to run.
    const engine = new RiskEngine({ config: config({ MODE: 'paper' }), clock });
    expect(engine.evaluate(request({ symbol: 'PEPE/USD' }), portfolio()).verdict).toBe('rejected');
  });

  it('lets the pair through once ALLOW_CRYPTO is set', () => {
    const engine = new RiskEngine({ config: config({ ALLOW_CRYPTO: 'true' }), clock });
    const decision = engine.evaluate(request({ symbol: 'DOGE/USD' }), portfolio());
    expect(decision.rejections.map((r) => r.rule)).not.toContain('instrument_permitted');
  });

  it('changes nothing for an equity', () => {
    // A safety fix that quietly stops the existing watchlist trading would be
    // a regression wearing a badge.
    const engine = new RiskEngine({ config: config(), clock });
    expect(engine.evaluate(request({ symbol: 'AAPL' }), portfolio()).verdict).toBe('approved');
  });

  it('records the check even when it passes', () => {
    // A gate that only appears in the log when it fires cannot be audited.
    const engine = new RiskEngine({ config: config(), clock });
    const decision = engine.evaluate(request(), portfolio());
    expect(decision.checks.map((c) => c.rule)).toContain('instrument_permitted');
  });
});

describe('live trading gate', () => {
  it('blocks live trading under a paper configuration', () => {
    expect(() => assertLiveTradingAllowed(config())).toThrow(LiveTradingBlockedError);
  });

  it('lists every unmet condition', () => {
    try {
      assertLiveTradingAllowed(config());
      throw new Error('expected the gate to block');
    } catch (err) {
      expect((err as LiveTradingBlockedError).reasons.length).toBeGreaterThan(1);
    }
  });

  const liveConfig = () =>
    config({
      MODE: 'live',
      LIVE_TRADING: 'true',
      PAPER_TRADING: 'false',
      LIVE_TRADING_CONFIRMATION: LIVE_CONFIRMATION_PHRASE,
      ALLOWED_ASSETS: 'AAPL',
    });

  const marketData = () =>
    new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200 } })],
      maxStalenessSeconds: 120,
      clock,
    });

  it('refuses to build a live broker without credentials, even when the gate passes', () => {
    expect(() => assertLiveTradingAllowed(liveConfig())).not.toThrow();
    // The gate opening is necessary, not sufficient.
    expect(() => createLiveBroker(liveConfig(), { marketData: marketData() })).toThrow(
      LiveTradingBlockedError,
    );
  });

  it('refuses to build a live broker under a paper configuration, credentials or not', () => {
    expect(() =>
      createLiveBroker(config({ ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }), {
        marketData: marketData(),
      }),
    ).toThrow(LiveTradingBlockedError);
  });
});

describe('Alpaca broker', () => {
  const marketData = () =>
    new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200 } })],
      maxStalenessSeconds: 120,
      clock,
    });

  function broker(overrides: Record<string, string> = {}, fetchImpl?: FetchImpl) {
    return new AlpacaBroker({
      config: config({ ALLOWED_ASSETS: 'AAPL', ...overrides }),
      endpoint: 'paper',
      apiKeyId: 'test-key-id',
      apiSecretKey: 'test-secret-key',
      marketData: marketData(),
      clock,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  it('exposes no method that could move money out of the account', () => {
    const surface = broker() as unknown as Record<string, unknown>;
    for (const forbidden of [
      'withdraw',
      'transfer',
      'createTransfer',
      'closeAccount',
      'updateBankDetails',
      'createAchRelationship',
      'requestJournal',
    ]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('rejects a symbol outside the allowlist before any request is made', async () => {
    let called = false;
    const fetchImpl: FetchImpl = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };

    await expect(
      broker({}, fetchImpl).placeOrder({
        symbol: 'TSLA',
        side: 'buy',
        quantity: 1,
        type: 'market',
        clientOrderId: 'o-1',
      }),
    ).rejects.toThrow(BrokerRejectionError);

    // The point is that nothing reached the broker at all.
    expect(called).toBe(false);
  });

  it('marks the paper endpoint as paper', () => {
    expect(broker().isPaper).toBe(true);
  });

  it('refuses a live endpoint under a paper configuration', () => {
    expect(
      () =>
        new AlpacaBroker({
          config: config({ ALLOWED_ASSETS: 'AAPL' }),
          endpoint: 'live',
          apiKeyId: 'k',
          apiSecretKey: 's',
          marketData: marketData(),
          clock,
        }),
    ).toThrow(LiveTradingBlockedError);
  });

  it('sends credentials in headers and never in the URL', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchImpl = async (url, init) => {
      seenUrl = url;
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ cash: '1000', currency: 'USD', equity: '1200', status: 'ACTIVE' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await broker({}, fetchImpl).getAccount();

    expect(seenUrl).not.toContain('test-secret-key');
    expect(seenHeaders['APCA-API-SECRET-KEY']).toBe('test-secret-key');
  });

  it('carries the client order id so a retry cannot become a second position', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchImpl = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'srv-1',
          client_order_id: 'o-42',
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          qty: '3',
          filled_qty: '0',
          status: 'accepted',
          submitted_at: '2026-08-16T12:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const order = await broker({}, fetchImpl).placeOrder({
      symbol: 'AAPL',
      side: 'buy',
      quantity: 3,
      type: 'market',
      clientOrderId: 'o-42',
    });

    expect(body.client_order_id).toBe('o-42');
    expect(body.time_in_force).toBe('day');
    expect(order.status).toBe('pending');
  });

  it('reads an unknown broker status as pending, never as filled', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response(
        JSON.stringify({
          id: 'srv-2',
          client_order_id: 'o-43',
          symbol: 'AAPL',
          side: 'buy',
          type: 'market',
          qty: '1',
          status: 'some_state_alpaca_added_later',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    expect((await broker({}, fetchImpl).getOrderStatus('srv-2')).status).toBe('pending');
  });

  it('refuses to sell more than it holds while short selling is off', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response(JSON.stringify([{ symbol: 'AAPL', qty: '2', avg_entry_price: '200' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await expect(
      broker({}, fetchImpl).placeOrder({
        symbol: 'AAPL',
        side: 'sell',
        quantity: 5,
        type: 'market',
        clientOrderId: 'o-44',
      }),
    ).rejects.toThrow(/short/i);
  });
});
