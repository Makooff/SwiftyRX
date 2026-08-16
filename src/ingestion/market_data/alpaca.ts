import { type Clock, systemClock } from '../../core/clock.js';
import { DataIntegrityError } from '../../core/errors.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
import type {
  AdapterKind,
  Bar,
  BarInterval,
  Freshness,
  HealthReport,
  Quote,
  SourceDescriptor,
} from '../../domain/types.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { MarketDataSource } from '../types.js';

/**
 * Alpaca Market Data v2 adapter (data only — no trading in this phase).
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - Paper accounts are available worldwide, including Belgium; live trading
 *    eligibility depends on country of tax residence and must be confirmed
 *    with Alpaca directly.
 *  - Free data plan: IEX feed only, ~200 requests/minute, 7+ years of history.
 *    IEX covers a single venue, so its prints are a *subset* of consolidated
 *    volume. Treat free-plan volume as indicative, not as market-wide volume.
 *  - The full-market SIP feed requires a paid subscription.
 *
 * This adapter reads market data exclusively. It has no order-placement
 * capability, by construction: broker execution arrives in Phase 5 behind the
 * BrokerAdapter interface.
 */

const ALPACA_REQUESTS_PER_MINUTE = 200;

const INTERVAL_MAP: Record<BarInterval, string> = {
  '1Min': '1Min',
  '5Min': '5Min',
  '15Min': '15Min',
  '1Hour': '1Hour',
  '1Day': '1Day',
};

interface AlpacaQuoteResponse {
  symbol?: string;
  quote?: {
    t: string; // RFC-3339 timestamp
    ap?: number; // ask price
    as?: number; // ask size
    bp?: number; // bid price
    bs?: number; // bid size
  };
}

interface AlpacaBarsResponse {
  symbol?: string;
  bars?: Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
    n?: number;
    vw?: number;
  }> | null;
  next_page_token?: string | null;
}

export const ALPACA_SOURCE: SourceDescriptor = describeSource({
  id: 'alpaca_data',
  name: 'Alpaca Market Data v2',
  tier: 'exchange',
  jurisdiction: 'US',
  url: 'https://alpaca.markets/data',
  licenceNote:
    'Free plan is IEX-only (single venue). SIP consolidated feed requires a paid subscription.',
});

export interface AlpacaMarketDataOptions {
  apiKeyId?: string;
  apiSecretKey?: string;
  /** "iex" (free) or "sip" (paid). Defaults to iex. */
  feed?: 'iex' | 'sip';
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export class AlpacaMarketDataAdapter implements MarketDataSource {
  readonly kind = 'market_data' as const;
  readonly id = 'alpaca_data';
  readonly requiresCredentials = true;
  readonly sources = [ALPACA_SOURCE];
  readonly delayNote: string;

  private readonly http: HttpClient;
  private readonly feed: 'iex' | 'sip';
  private readonly hasCredentials: boolean;
  private readonly clock: Clock;
  private lastSuccessAt?: string;

  constructor(options: AlpacaMarketDataOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.feed = options.feed ?? 'iex';
    this.hasCredentials = Boolean(options.apiKeyId && options.apiSecretKey);
    this.delayNote =
      this.feed === 'iex'
        ? 'IEX feed: real-time for IEX-executed trades only; not consolidated tape.'
        : 'SIP feed: consolidated US market data (paid subscription).';

    registerSecret(options.apiSecretKey);
    registerSecret(options.apiKeyId);
    sourceRegistry.register(ALPACA_SOURCE);

    this.http = new HttpClient({
      name: 'alpaca_data',
      baseUrl: 'https://data.alpaca.markets/v2/',
      defaultHeaders: {
        'APCA-API-KEY-ID': options.apiKeyId ?? '',
        'APCA-API-SECRET-KEY': options.apiSecretKey ?? '',
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(ALPACA_REQUESTS_PER_MINUTE, this.clock),
      clock: this.clock,
      logger: options.logger ?? createLogger('alpaca-data'),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return this.hasCredentials;
  }

  private freshness(asOf: string): Freshness {
    return {
      asOf,
      retrievedAt: this.clock.now().toISOString(),
      // The IEX feed is real-time for the trades it sees, but it is not the
      // consolidated tape. Labelling it "realtime" without that caveat would
      // overstate what we actually have.
      delayClass: this.feed === 'sip' ? 'realtime' : 'delayed_other',
      feed: `alpaca:${this.feed}`,
    };
  }

  async getQuote(symbol: string): Promise<Quote> {
    const payload = await this.http.getJson<AlpacaQuoteResponse>(
      `stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      { query: { feed: this.feed } },
    );

    const quote = payload.quote;
    if (!quote?.t) {
      throw new DataIntegrityError(`Alpaca returned no quote for ${symbol}`, { symbol });
    }

    this.lastSuccessAt = this.clock.now().toISOString();

    const bid = quote.bp;
    const ask = quote.ap;
    return {
      symbol: payload.symbol ?? symbol,
      ...(bid !== undefined ? { bid } : {}),
      ...(ask !== undefined ? { ask } : {}),
      ...(quote.bs !== undefined ? { bidSize: quote.bs } : {}),
      ...(quote.as !== undefined ? { askSize: quote.as } : {}),
      // Mid is derived, not reported; only meaningful with both sides present.
      ...(bid !== undefined && ask !== undefined && bid > 0 && ask > 0
        ? { last: (bid + ask) / 2 }
        : {}),
      currency: 'USD',
      freshness: this.freshness(quote.t),
    };
  }

  async getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<Bar[]> {
    const payload = await this.http.getJson<AlpacaBarsResponse>(
      `stocks/${encodeURIComponent(symbol)}/bars`,
      {
        query: {
          timeframe: INTERVAL_MAP[interval],
          start: options.start.toISOString(),
          ...(options.end ? { end: options.end.toISOString() } : {}),
          limit: options.limit ?? 1000,
          feed: this.feed,
          adjustment: 'split',
        },
      },
    );

    this.lastSuccessAt = this.clock.now().toISOString();

    return (payload.bars ?? []).map((bar) => ({
      symbol: payload.symbol ?? symbol,
      timestamp: bar.t,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      ...(bar.vw !== undefined ? { vwap: bar.vw } : {}),
      ...(bar.n !== undefined ? { tradeCount: bar.n } : {}),
      interval,
      freshness: this.freshness(bar.t),
    }));
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const base = {
      adapter: this.id,
      kind: this.kind as AdapterKind,
      checkedAt,
      requiresCredentials: true,
      credentialsPresent: this.hasCredentials,
    };

    if (!this.hasCredentials) {
      return {
        ...base,
        state: 'disabled',
        detail: 'ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set',
      };
    }

    const startedAt = this.clock.nowMs();
    try {
      await this.getQuote('AAPL');
      return {
        ...base,
        state: 'healthy',
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      };
    } catch (err) {
      return {
        ...base,
        state: 'unavailable',
        detail: (err as Error).message,
        latencyMs: this.clock.nowMs() - startedAt,
      };
    }
  }

  getStats() {
    return this.http.getStats();
  }
}
