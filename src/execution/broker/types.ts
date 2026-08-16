import type { Quote } from '../../domain/types.js';

/**
 * Broker interface.
 *
 * **This interface has no method to withdraw funds, transfer money, change
 * bank details, or close an account — and it must never gain one.** If a
 * broker's SDK exposes such calls, they are not surfaced here. The capability
 * is absent from the type, so no amount of downstream code can reach it.
 *
 * Every implementation is limited to: look at the account, look at positions,
 * look at a price, place an order, cancel an order, check an order.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'pending' | 'filled' | 'partially_filled' | 'cancelled' | 'rejected';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  /** Required for limit orders. */
  limitPrice?: number;
  /** Idempotency key. A broker must not place the same id twice. */
  clientOrderId: string;
  /** Free-text audit note linking the order to the signal that proposed it. */
  reason?: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  /** Average fill price, once filled. */
  filledPrice?: number;
  status: OrderStatus;
  submittedAt: string;
  filledAt?: string;
  /** Commission charged, in account currency. */
  commission?: number;
  /** Difference between the reference price and the fill, in account currency. */
  slippage?: number;
  rejectReason?: string;
}

export interface Account {
  /** Cash available to trade. */
  cash: number;
  currency: string;
  /** Cash plus marked positions. */
  totalValue: number;
  /** True when this account cannot touch real money. */
  isPaper: boolean;
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealisedPnl: number;
  openedAt: string;
}

export interface BrokerAdapter {
  readonly id: string;
  /** False only for a live broker that has passed every safety gate. */
  readonly isPaper: boolean;
  getAccount(): Promise<Account>;
  getPositions(): Promise<BrokerPosition[]>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(order: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  getOrderStatus(orderId: string): Promise<Order>;
}

/** The broker refused the order. Never swallowed — always surfaced. */
export class BrokerRejectionError extends Error {
  constructor(
    message: string,
    public readonly clientOrderId: string,
  ) {
    super(message);
    this.name = 'BrokerRejectionError';
  }
}

/** An order with this client id was already submitted. */
export class DuplicateOrderError extends Error {
  constructor(public readonly clientOrderId: string) {
    super(`Order ${clientOrderId} was already submitted`);
    this.name = 'DuplicateOrderError';
  }
}
