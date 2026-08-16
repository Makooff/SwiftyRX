import type { AppConfig } from '../../config/env.js';
import { type Clock, systemClock } from '../../core/clock.js';
import { UpstreamError } from '../../core/errors.js';
import { type FetchImpl, HttpClient } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
import type { Quote } from '../../domain/types.js';
import type { MarketDataService } from '../../ingestion/market_data/index.js';
import {
  BrokerRejectionError,
  DuplicateOrderError,
  type Account,
  type BrokerAdapter,
  type BrokerPosition,
  type Order,
  type OrderRequest,
  type OrderStatus,
} from '../broker/types.js';
import { assertLiveTradingAllowed } from './live-broker.js';

/**
 * Alpaca broker adapter.
 *
 * Implements the six `BrokerAdapter` methods and nothing else. Alpaca's API has
 * endpoints for transfers, ACH relationships and account configuration; none of
 * them is reachable from this file, and none may ever be added. The absence is
 * the safety property.
 *
 * Two endpoints, one implementation:
 *  - `paper` → `paper-api.alpaca.markets`, no real money, no gate beyond keys.
 *  - `live`  → `api.alpaca.markets`, real money, gated by
 *    `assertLiveTradingAllowed` on top of the startup config validation.
 *
 * The paper endpoint exists so the adapter can be proven against the real API
 * before any real money is involved. That is the intended path: local
 * simulation, then Alpaca paper, then — only with evidence — live.
 *
 * **Not verified against the live API.** Built from Alpaca's published Trading
 * API documentation and tested against recorded fixtures. Endpoint shapes come
 * from the docs, never from guesswork, but the first real run may still find a
 * payload mismatch. Run against `paper` first and read every response.
 */

const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
const LIVE_BASE_URL = 'https://api.alpaca.markets';

/** Alpaca publishes 200 req/min; staying under it avoids a throttle-induced miss. */
const SELF_IMPOSED_RPM = 180;

export type AlpacaEndpoint = 'paper' | 'live';

export interface AlpacaBrokerOptions {
  config: AppConfig;
  endpoint: AlpacaEndpoint;
  apiKeyId: string;
  apiSecretKey: string;
  /** Used by `getQuote`; Alpaca's trading API does not price instruments. */
  marketData: MarketDataService;
  clock?: Clock;
  logger?: Logger;
  timeoutMs?: number;
  /** Injection seam: tests pass a fixture-backed fetch, never the network. */
  fetchImpl?: FetchImpl;
}

/** Subset of Alpaca's order payload this adapter reads. */
interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  order_type?: string;
  type?: string;
  qty?: string | null;
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  status: string;
  submitted_at?: string;
  created_at?: string;
  filled_at?: string | null;
}

interface AlpacaAccount {
  cash: string;
  currency: string;
  equity: string;
  status: string;
  trading_blocked?: boolean;
  account_blocked?: boolean;
}

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price?: string | null;
  market_value?: string | null;
  unrealized_pl?: string | null;
}

/**
 * Alpaca order states mapped onto the four this system reasons about.
 *
 * Anything unrecognised becomes `pending` rather than `filled`: an unknown
 * state must never be read as "the money moved".
 */
function mapStatus(status: string): OrderStatus {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partially_filled';
    case 'canceled':
    case 'expired':
    case 'done_for_day':
      return 'cancelled';
    case 'rejected':
    case 'suspended':
      return 'rejected';
    default:
      return 'pending';
  }
}

function num(value: string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class AlpacaBroker implements BrokerAdapter {
  readonly id: string;
  readonly isPaper: boolean;

  private readonly http: HttpClient;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly marketData: MarketDataService;
  private readonly allowedAssets: Set<string>;
  private readonly config: AppConfig;

  constructor(options: AlpacaBrokerOptions) {
    this.config = options.config;
    this.isPaper = options.endpoint === 'paper';
    this.id = `alpaca_${options.endpoint}`;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger(this.id);
    this.marketData = options.marketData;

    // The gate opens only for the live endpoint, and only when every condition
    // holds. The startup validator has already checked these; this is the
    // second, independent check at the point of use.
    if (options.endpoint === 'live') {
      assertLiveTradingAllowed(options.config);
    }

    if (!options.apiKeyId || !options.apiSecretKey) {
      throw new Error(`${this.id}: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required`);
    }
    registerSecret(options.apiKeyId);
    registerSecret(options.apiSecretKey);

    // The allowlist is enforced here as well as in the Risk Engine. A single
    // check is a single mistake away from an order on an unintended symbol.
    this.allowedAssets = new Set(options.config.ALLOWED_ASSETS.map((a) => a.toUpperCase()));

    this.http = new HttpClient({
      name: this.id,
      baseUrl: this.isPaper ? PAPER_BASE_URL : LIVE_BASE_URL,
      // Credentials go in headers, never in a URL, so they cannot leak through
      // a logged query string.
      defaultHeaders: {
        'APCA-API-KEY-ID': options.apiKeyId,
        'APCA-API-SECRET-KEY': options.apiSecretKey,
      },
      rateLimit: TokenBucket.perMinute(SELF_IMPOSED_RPM, this.clock),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      clock: this.clock,
      logger: this.log,
    });
  }

  async getAccount(): Promise<Account> {
    const account = await this.http.getJson<AlpacaAccount>('/v2/account');

    // A blocked account that still answers queries would otherwise look
    // healthy right up to the first rejected order.
    if (account.trading_blocked || account.account_blocked) {
      this.log.error({ status: account.status }, 'broker account is blocked from trading');
    }

    return {
      cash: num(account.cash),
      currency: account.currency || 'USD',
      totalValue: num(account.equity),
      isPaper: this.isPaper,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const positions = await this.http.getJson<AlpacaPosition[]>('/v2/positions');
    return positions.map((p) => {
      const quantity = num(p.qty);
      const averagePrice = num(p.avg_entry_price);
      const currentPrice = num(p.current_price, averagePrice);
      return {
        symbol: p.symbol,
        quantity,
        averagePrice,
        currentPrice,
        marketValue: num(p.market_value, quantity * currentPrice),
        unrealisedPnl: num(p.unrealized_pl, quantity * (currentPrice - averagePrice)),
        // Alpaca does not report an open time on a position; the aggregate has
        // no single one. Reporting "now" would be a lie with a timestamp on it.
        openedAt: '',
      };
    });
  }

  /**
   * Prices come from the market data service, not the trading API.
   *
   * Keeping them separate means every price still carries the `Freshness`
   * envelope the staleness rule depends on — a broker quote with no age is
   * exactly the input that rule exists to reject.
   */
  async getQuote(symbol: string): Promise<Quote> {
    const result = await this.marketData.getQuote(symbol);
    return result.quote;
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    const symbol = request.symbol.toUpperCase();

    if (!this.allowedAssets.has(symbol)) {
      throw new BrokerRejectionError(
        `${symbol} is not in ALLOWED_ASSETS — the adapter refuses to route it`,
        request.clientOrderId,
      );
    }
    if (request.quantity <= 0) {
      throw new BrokerRejectionError('Order quantity must be positive', request.clientOrderId);
    }
    if (request.type === 'limit' && request.limitPrice === undefined) {
      throw new BrokerRejectionError('A limit order requires a limit price', request.clientOrderId);
    }
    if (request.side === 'sell' && !this.config.ALLOW_SHORT_SELLING) {
      // The Risk Engine checks holdings; the adapter cannot, so it checks the
      // permission instead. Both are needed: a naked short is a different risk
      // from an oversized one.
      const positions = await this.getPositions();
      const held = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
      if (held < request.quantity) {
        throw new BrokerRejectionError(
          `Selling ${request.quantity} ${symbol} while holding ${held} would open a short, and ALLOW_SHORT_SELLING is false`,
          request.clientOrderId,
        );
      }
    }

    const body: Record<string, unknown> = {
      symbol,
      qty: String(request.quantity),
      side: request.side,
      type: request.type,
      // `day` rather than `gtc`: an order that outlives the session it was
      // reasoned about is an order nobody decided to place today.
      time_in_force: 'day',
      // Alpaca rejects a duplicate client_order_id, which makes retry-after-
      // timeout safe: the second attempt cannot become a second position.
      client_order_id: request.clientOrderId,
      ...(request.limitPrice !== undefined ? { limit_price: String(request.limitPrice) } : {}),
    };

    let response: AlpacaOrder;
    try {
      response = await this.http.getJson<AlpacaOrder>('/v2/orders', {
        method: 'POST',
        body,
        // Never retried. A timeout does not mean the order was not accepted,
        // and a blind retry is how one decision becomes two positions. The
        // client order id makes a *deliberate* retry safe; an automatic one
        // still hides the ambiguity from the operator.
        retry: false,
      });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 422) {
        throw new DuplicateOrderError(request.clientOrderId);
      }
      throw new BrokerRejectionError(
        `Alpaca rejected the order: ${(err as Error).message}`,
        request.clientOrderId,
      );
    }

    this.log.info(
      {
        symbol,
        side: request.side,
        quantity: request.quantity,
        orderId: response.id,
        status: response.status,
        real: !this.isPaper,
      },
      this.isPaper ? 'paper order submitted to Alpaca' : 'REAL MONEY order submitted',
    );

    return this.toOrder(response);
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Read as text, not JSON: a successful cancel answers 204 with an empty
    // body, and a JSON parse of "" throws on the happy path.
    await this.http.getText(`/v2/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
      retry: false,
    });
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    const order = await this.http.getJson<AlpacaOrder>(
      `/v2/orders/${encodeURIComponent(orderId)}`,
    );
    return this.toOrder(order);
  }

  private toOrder(order: AlpacaOrder): Order {
    const filledQuantity = num(order.filled_qty);
    const filledPrice = num(order.filled_avg_price, Number.NaN);

    return {
      id: order.id,
      clientOrderId: order.client_order_id,
      symbol: order.symbol,
      side: order.side === 'sell' ? 'sell' : 'buy',
      type: (order.order_type ?? order.type) === 'limit' ? 'limit' : 'market',
      quantity: num(order.qty),
      filledQuantity,
      ...(Number.isFinite(filledPrice) ? { filledPrice } : {}),
      status: mapStatus(order.status),
      submittedAt: order.submitted_at ?? order.created_at ?? this.clock.now().toISOString(),
      ...(order.filled_at ? { filledAt: order.filled_at } : {}),
    };
  }

  /** Diagnostics for the health page. Never probed with an order. */
  async health(): Promise<{ state: 'healthy' | 'degraded' | 'unavailable'; detail?: string }> {
    try {
      const account = await this.http.getJson<AlpacaAccount>('/v2/account');
      if (account.trading_blocked || account.account_blocked) {
        return { state: 'degraded', detail: `account status ${account.status}, trading blocked` };
      }
      return {
        state: 'healthy',
        detail: `${this.isPaper ? 'paper' : 'LIVE'} account, status ${account.status}`,
      };
    } catch (err) {
      return { state: 'unavailable', detail: (err as Error).message };
    }
  }
}
