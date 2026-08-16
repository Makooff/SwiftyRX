import { type Clock, systemClock } from '../../core/clock.js';
import { sha256 } from '../../core/hash.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type { Quote } from '../../domain/types.js';
import type { MarketDataService } from '../../ingestion/market_data/index.js';
import { DEFAULT_COST_MODEL, estimateFill, type CostModel } from '../costs.js';
import {
  BrokerRejectionError,
  DuplicateOrderError,
  type Account,
  type BrokerAdapter,
  type BrokerPosition,
  type Order,
  type OrderRequest,
} from '../broker/types.js';
import { Portfolio } from './portfolio.js';

/**
 * Paper broker.
 *
 * Simulates fills against real market data, with commission and slippage
 * applied to every trade. It touches no money and holds no credentials — there
 * is nothing here that could reach a real account even by mistake.
 *
 * Fills are deliberately conservative:
 *  - Every fill crosses the spread and pays modelled impact.
 *  - Orders are filled at the *current* quote, never at a price from before
 *    the decision was made.
 *  - A stale or missing quote rejects the order rather than filling at a
 *    guessed price.
 */

export interface PaperBrokerOptions {
  portfolio: Portfolio;
  marketData: MarketDataService;
  costModel?: CostModel;
  clock?: Clock;
  logger?: Logger;
  /** Maximum quote age accepted for a fill. */
  maxQuoteAgeSeconds?: number;
}

export class PaperBroker implements BrokerAdapter {
  readonly id = 'paper';
  readonly isPaper = true;

  private readonly portfolio: Portfolio;
  private readonly marketData: MarketDataService;
  private readonly costModel: CostModel;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly maxQuoteAgeSeconds: number;
  private readonly orders = new Map<string, Order>();
  private readonly byClientId = new Map<string, string>();

  constructor(options: PaperBrokerOptions) {
    this.portfolio = options.portfolio;
    this.marketData = options.marketData;
    this.costModel = options.costModel ?? DEFAULT_COST_MODEL;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('paper-broker');
    this.maxQuoteAgeSeconds = options.maxQuoteAgeSeconds ?? 120;
  }

  async getAccount(): Promise<Account> {
    return {
      cash: this.portfolio.availableCash,
      currency: this.portfolio.currency,
      totalValue: this.portfolio.totalValue,
      isPaper: true,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.portfolio.openPositions.map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      averagePrice: position.averagePrice,
      currentPrice:
        position.quantity > 0 ? Number((position.marketValue / position.quantity).toFixed(4)) : 0,
      marketValue: position.marketValue,
      unrealisedPnl: position.unrealisedPnl,
      openedAt: position.openedAt,
    }));
  }

  async getQuote(symbol: string): Promise<Quote> {
    const result = await this.marketData.getQuote(symbol, {
      maxStalenessSeconds: this.maxQuoteAgeSeconds,
    });
    return result.quote;
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    if (this.byClientId.has(request.clientOrderId)) {
      // Duplicate protection lives here as well as in the Risk Engine: a
      // single layer is a single point of failure for double-spending.
      throw new DuplicateOrderError(request.clientOrderId);
    }

    const submittedAt = this.clock.now().toISOString();
    const id = sha256(`${request.clientOrderId}|${submittedAt}`).slice(0, 20);

    if (request.quantity <= 0) {
      throw new BrokerRejectionError('Order quantity must be positive', request.clientOrderId);
    }

    let quote: Quote;
    try {
      quote = await this.getQuote(request.symbol);
    } catch (err) {
      // No usable price means no fill. Filling at a stale or invented price
      // would make every downstream number fiction.
      const order: Order = {
        id,
        clientOrderId: request.clientOrderId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        filledQuantity: 0,
        status: 'rejected',
        submittedAt,
        rejectReason: `no usable quote: ${(err as Error).message}`,
      };
      this.record(order);
      throw new BrokerRejectionError(order.rejectReason!, request.clientOrderId);
    }

    const reference = quote.last ?? (quote.bid && quote.ask ? (quote.bid + quote.ask) / 2 : undefined);
    if (reference === undefined || reference <= 0) {
      const order: Order = {
        id,
        clientOrderId: request.clientOrderId,
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        quantity: request.quantity,
        filledQuantity: 0,
        status: 'rejected',
        submittedAt,
        rejectReason: 'quote contained no usable price',
      };
      this.record(order);
      throw new BrokerRejectionError(order.rejectReason!, request.clientOrderId);
    }

    const fill = estimateFill(reference, request.quantity, request.side, this.costModel);

    if (request.type === 'limit' && request.limitPrice !== undefined) {
      const wouldFill =
        request.side === 'buy' ? fill.fillPrice <= request.limitPrice : fill.fillPrice >= request.limitPrice;
      if (!wouldFill) {
        const order: Order = {
          id,
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          quantity: request.quantity,
          filledQuantity: 0,
          status: 'pending',
          submittedAt,
        };
        this.record(order);
        return order;
      }
    }

    if (request.side === 'buy') {
      const required = request.quantity * fill.fillPrice + fill.commission;
      if (required > this.portfolio.availableCash) {
        const order: Order = {
          id,
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          quantity: request.quantity,
          filledQuantity: 0,
          status: 'rejected',
          submittedAt,
          rejectReason: `insufficient cash: need ${required.toFixed(2)}, have ${this.portfolio.availableCash.toFixed(2)}`,
        };
        this.record(order);
        throw new BrokerRejectionError(order.rejectReason!, request.clientOrderId);
      }
      this.portfolio.applyBuy(request.symbol, request.quantity, fill.fillPrice, fill.commission);
    } else {
      const position = this.portfolio.openPositions.find((p) => p.symbol === request.symbol);
      if (!position || position.quantity < request.quantity) {
        const order: Order = {
          id,
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          quantity: request.quantity,
          filledQuantity: 0,
          status: 'rejected',
          submittedAt,
          rejectReason: `cannot sell ${request.quantity} of ${request.symbol}: holding ${position?.quantity ?? 0}`,
        };
        this.record(order);
        throw new BrokerRejectionError(order.rejectReason!, request.clientOrderId);
      }
      this.portfolio.applySell(request.symbol, request.quantity, fill.fillPrice, fill.commission);
    }

    const order: Order = {
      id,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      filledQuantity: request.quantity,
      filledPrice: fill.fillPrice,
      status: 'filled',
      submittedAt,
      filledAt: this.clock.now().toISOString(),
      commission: fill.commission,
      slippage: fill.slippage,
    };
    this.record(order);

    this.log.info(
      {
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        fillPrice: fill.fillPrice,
        referencePrice: reference,
        commission: fill.commission,
        slippage: fill.slippage,
        costPercent: fill.costPercent,
      },
      'paper order filled',
    );

    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    if (order.status === 'filled') throw new Error(`Order ${orderId} is already filled`);
    order.status = 'cancelled';
  }

  async getOrderStatus(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    return { ...order };
  }

  /** All orders, newest last. */
  get orderHistory(): Order[] {
    return [...this.orders.values()];
  }

  private record(order: Order): void {
    this.orders.set(order.id, order);
    this.byClientId.set(order.clientOrderId, order.id);
  }
}
