import { type Clock, systemClock } from '../../core/clock.js';
import { DataIntegrityError, UpstreamError } from '../../core/errors.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
import type {
  AdapterKind,
  Bar,
  BarInterval,
  HealthReport,
  NormalizedDocument,
  Quote,
  SourceDescriptor,
} from '../../domain/types.js';
import { normalizeDocument } from '../normalize.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { FetchWindow, MarketDataSource } from '../types.js';

/**
 * Finnhub adapter — quotes plus company news.
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - Free tier: 60 API calls/minute, personal non-commercial use only. A
 *    monetised deployment requires a paid plan; that is a licensing decision
 *    for the operator, not something this code can grant.
 *  - Free-tier US quotes are real-time; historical candles (/stock/candle) are
 *    a paid entitlement and return 403 on the free tier. `getBars()` surfaces
 *    that plainly instead of pretending the data exists.
 */

const FINNHUB_FREE_CALLS_PER_MINUTE = 60;

const RESOLUTION_MAP: Record<BarInterval, string> = {
  '1Min': '1',
  '5Min': '5',
  '15Min': '15',
  '1Hour': '60',
  '1Day': 'D',
};

interface FinnhubQuoteResponse {
  c?: number; // current price
  d?: number; // change
  dp?: number; // percent change
  h?: number; // high of day
  l?: number; // low of day
  o?: number; // open
  pc?: number; // previous close
  t?: number; // UNIX seconds
}

interface FinnhubCandleResponse {
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  v?: number[];
  t?: number[];
  s?: string; // "ok" | "no_data"
}

interface FinnhubNewsItem {
  category?: string;
  datetime?: number;
  headline?: string;
  id?: number;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
}

export const FINNHUB_SOURCE: SourceDescriptor = describeSource({
  id: 'finnhub',
  name: 'Finnhub',
  tier: 'aggregator',
  jurisdiction: 'GLOBAL',
  url: 'https://finnhub.io',
  reliability: 0.6,
  licenceNote: 'Free tier is personal, non-commercial use only. Commercial use requires a paid plan.',
});

export const FINNHUB_NEWS_SOURCE: SourceDescriptor = describeSource({
  id: 'finnhub_company_news',
  name: 'Finnhub — company news (aggregated)',
  tier: 'aggregator',
  jurisdiction: 'GLOBAL',
  reliability: 0.5,
  licenceNote: 'Aggregated third-party headlines. Original publisher governs reuse.',
});

export interface FinnhubOptions {
  apiKey?: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Set true when the account has a paid candles entitlement. */
  hasCandlesEntitlement?: boolean;
}

export class FinnhubAdapter implements MarketDataSource {
  readonly kind = 'market_data' as const;
  readonly id = 'finnhub';
  readonly requiresCredentials = true;
  readonly sources = [FINNHUB_SOURCE, FINNHUB_NEWS_SOURCE];
  readonly delayNote = 'Free tier: real-time US quotes; historical candles require a paid plan.';

  private readonly http: HttpClient;
  private readonly apiKey?: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly hasCandlesEntitlement: boolean;
  private lastSuccessAt?: string;

  constructor(options: FinnhubOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('finnhub');
    this.hasCandlesEntitlement = options.hasCandlesEntitlement ?? false;
    if (options.apiKey) {
      this.apiKey = options.apiKey;
      registerSecret(options.apiKey);
    }
    sourceRegistry.registerAll(this.sources);

    this.http = new HttpClient({
      name: 'finnhub',
      baseUrl: 'https://finnhub.io/api/v1/',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(FINNHUB_FREE_CALLS_PER_MINUTE, this.clock),
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) throw new Error('FINNHUB_API_KEY is not configured');
    return this.apiKey;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const payload = await this.http.getJson<FinnhubQuoteResponse>('quote', {
      query: { symbol, token: this.requireKey() },
    });

    // Finnhub answers unknown symbols with a 200 and an all-zero body.
    if (!payload.t || payload.c === undefined || payload.c === 0) {
      throw new DataIntegrityError(`Finnhub returned no usable quote for ${symbol}`, { symbol });
    }

    const asOf = new Date(payload.t * 1000).toISOString();
    this.lastSuccessAt = this.clock.now().toISOString();

    return {
      symbol,
      last: payload.c,
      currency: 'USD',
      freshness: {
        asOf,
        retrievedAt: this.clock.now().toISOString(),
        delayClass: 'realtime',
        feed: 'finnhub:us',
      },
    };
  }

  async getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<Bar[]> {
    if (!this.hasCandlesEntitlement) {
      // Failing loudly beats returning an empty array that a strategy would
      // silently interpret as "no market activity".
      throw new UpstreamError(
        'Finnhub /stock/candle requires a paid entitlement; set hasCandlesEntitlement only if your plan includes it',
        403,
        { symbol, interval },
      );
    }

    const end = options.end ?? this.clock.now();
    const payload = await this.http.getJson<FinnhubCandleResponse>('stock/candle', {
      query: {
        symbol,
        resolution: RESOLUTION_MAP[interval],
        from: Math.floor(options.start.getTime() / 1000),
        to: Math.floor(end.getTime() / 1000),
        token: this.requireKey(),
      },
    });

    if (payload.s !== 'ok' || !payload.t?.length) return [];

    const retrievedAt = this.clock.now().toISOString();
    this.lastSuccessAt = retrievedAt;

    const bars: Bar[] = [];
    for (let i = 0; i < payload.t.length; i++) {
      const timestamp = payload.t[i];
      const open = payload.o?.[i];
      const high = payload.h?.[i];
      const low = payload.l?.[i];
      const close = payload.c?.[i];
      if (timestamp === undefined || open === undefined || high === undefined) continue;
      if (low === undefined || close === undefined) continue;

      const asOf = new Date(timestamp * 1000).toISOString();
      bars.push({
        symbol,
        timestamp: asOf,
        open,
        high,
        low,
        close,
        volume: payload.v?.[i] ?? 0,
        interval,
        freshness: { asOf, retrievedAt, delayClass: 'end_of_day', feed: 'finnhub:candles' },
      });
    }
    return options.limit ? bars.slice(-options.limit) : bars;
  }

  /** Company news headlines. Aggregated content — treated as a low-tier source. */
  async fetchCompanyNews(symbol: string, window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    const to = this.clock.now();
    const from = window.since ?? new Date(to.getTime() - 24 * 3600 * 1000);

    const payload = await this.http.getJson<FinnhubNewsItem[]>('company-news', {
      query: {
        symbol,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        token: this.requireKey(),
      },
    });

    const retrievedAt = this.clock.now().toISOString();
    this.lastSuccessAt = retrievedAt;

    const docs = (Array.isArray(payload) ? payload : []).map((item) =>
      normalizeDocument(
        {
          sourceId: FINNHUB_NEWS_SOURCE.id,
          ...(item.id !== undefined ? { externalId: String(item.id) } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.headline ? { title: item.headline } : {}),
          content: item.summary ?? '',
          ...(item.datetime ? { publishedAt: new Date(item.datetime * 1000).toISOString() } : {}),
          retrievedAt,
          raw: item,
        },
        {
          clock: this.clock,
          declaredTickers: [symbol],
          metadata: {
            originalPublisher: item.source ?? 'unknown',
            category: item.category ?? 'company',
            related: item.related ?? symbol,
          },
        },
      ),
    );

    return window.limit ? docs.slice(0, window.limit) : docs;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const base = {
      adapter: this.id,
      kind: this.kind as AdapterKind,
      checkedAt,
      requiresCredentials: true,
      credentialsPresent: this.isConfigured(),
    };

    if (!this.isConfigured()) {
      return { ...base, state: 'disabled', detail: 'FINNHUB_API_KEY not set' };
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
