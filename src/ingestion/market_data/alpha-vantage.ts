import { type Clock, systemClock } from '../../core/clock.js';
import { DataIntegrityError, RateLimitError } from '../../core/errors.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { DailyQuota, TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
import type {
  AdapterKind,
  Bar,
  BarInterval,
  HealthReport,
  Quote,
  SourceDescriptor,
} from '../../domain/types.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { MarketDataSource } from '../types.js';

/**
 * Alpha Vantage adapter — daily bars and last-close quotes.
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - Free tier: 25 requests/DAY and 5 requests/minute. That is a hard ceiling,
 *    so this adapter is a historical-data fallback, never a polling source.
 *  - Paid plans start around $49.99/month.
 *  - The API answers quota violations with HTTP 200 and an explanatory JSON
 *    body, so the response body — not the status code — has to be inspected.
 */

const AV_FREE_PER_MINUTE = 5;
const AV_FREE_PER_DAY = 25;

const INTRADAY_INTERVALS: Partial<Record<BarInterval, string>> = {
  '1Min': '1min',
  '5Min': '5min',
  '15Min': '15min',
  '1Hour': '60min',
};

interface AvSeriesResponse {
  'Meta Data'?: Record<string, string>;
  'Time Series (Daily)'?: Record<string, Record<string, string>>;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
  [key: string]: unknown;
}

export const ALPHA_VANTAGE_SOURCE: SourceDescriptor = describeSource({
  id: 'alpha_vantage',
  name: 'Alpha Vantage',
  tier: 'aggregator',
  jurisdiction: 'GLOBAL',
  url: 'https://www.alphavantage.co',
  reliability: 0.6,
  licenceNote: 'Free tier: 25 requests/day. Commercial use requires a paid plan.',
});

export interface AlphaVantageOptions {
  apiKey?: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Raise when on a paid plan. */
  requestsPerMinute?: number;
  requestsPerDay?: number;
}

export class AlphaVantageAdapter implements MarketDataSource {
  readonly kind = 'market_data' as const;
  readonly id = 'alpha_vantage';
  readonly requiresCredentials = true;
  readonly sources = [ALPHA_VANTAGE_SOURCE];
  readonly delayNote =
    'Free tier: end-of-day and delayed intraday data, 25 requests/day. Not suitable for polling.';

  private readonly http: HttpClient;
  private readonly apiKey?: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly dailyQuota: DailyQuota;
  private lastSuccessAt?: string;

  constructor(options: AlphaVantageOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('alpha-vantage');
    if (options.apiKey) {
      this.apiKey = options.apiKey;
      registerSecret(options.apiKey);
    }
    sourceRegistry.register(ALPHA_VANTAGE_SOURCE);

    this.dailyQuota = new DailyQuota(options.requestsPerDay ?? AV_FREE_PER_DAY, this.clock);
    this.http = new HttpClient({
      name: 'alpha_vantage',
      baseUrl: 'https://www.alphavantage.co/',
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(options.requestsPerMinute ?? AV_FREE_PER_MINUTE, this.clock),
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  get remainingDailyRequests(): number {
    return this.dailyQuota.remaining;
  }

  private requireKey(): string {
    if (!this.apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not configured');
    return this.apiKey;
  }

  private async call(query: Record<string, string | number>): Promise<AvSeriesResponse> {
    if (!this.dailyQuota.canSpend()) {
      throw new RateLimitError(
        'Alpha Vantage daily request budget exhausted',
        undefined,
        { remaining: 0 },
      );
    }
    this.dailyQuota.spend();

    const payload = await this.http.getJson<AvSeriesResponse>('query', {
      query: { ...query, apikey: this.requireKey() },
    });

    // Quota and error conditions arrive as HTTP 200 with an explanatory body.
    if (payload.Note || payload.Information) {
      const message = String(payload.Note ?? payload.Information);
      if (/limit|frequency|premium/i.test(message)) {
        throw new RateLimitError(`Alpha Vantage: ${message}`, undefined, {});
      }
      throw new DataIntegrityError(`Alpha Vantage: ${message}`);
    }
    if (payload['Error Message']) {
      throw new DataIntegrityError(`Alpha Vantage: ${String(payload['Error Message'])}`);
    }

    this.lastSuccessAt = this.clock.now().toISOString();
    return payload;
  }

  /**
   * Last close, exposed as a Quote.
   *
   * Deliberately not a live price: the freshness envelope says `end_of_day`, so
   * the staleness guard will reject it for anything requiring current prices.
   */
  async getQuote(symbol: string): Promise<Quote> {
    const bars = await this.getBars(symbol, '1Day', {
      start: new Date(this.clock.nowMs() - 10 * 86_400_000),
      limit: 1,
    });
    const latest = bars[bars.length - 1];
    if (!latest) {
      throw new DataIntegrityError(`Alpha Vantage returned no bars for ${symbol}`, { symbol });
    }
    return {
      symbol,
      last: latest.close,
      currency: 'USD',
      freshness: latest.freshness,
    };
  }

  async getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<Bar[]> {
    const intraday = INTRADAY_INTERVALS[interval];
    const payload = await this.call(
      intraday
        ? { function: 'TIME_SERIES_INTRADAY', symbol, interval: intraday, outputsize: 'compact' }
        : {
            function: 'TIME_SERIES_DAILY',
            symbol,
            // "full" is ~20 years; only requested when the caller needs depth.
            outputsize: options.start.getTime() < this.clock.nowMs() - 100 * 86_400_000 ? 'full' : 'compact',
          },
    );

    const seriesKey = Object.keys(payload).find((key) => key.startsWith('Time Series'));
    const series = seriesKey ? (payload[seriesKey] as Record<string, Record<string, string>>) : undefined;
    if (!series) {
      throw new DataIntegrityError(`Alpha Vantage response had no time series for ${symbol}`, {
        symbol,
        keys: Object.keys(payload),
      });
    }

    const retrievedAt = this.clock.now().toISOString();
    const endMs = options.end?.getTime() ?? Number.POSITIVE_INFINITY;
    const bars: Bar[] = [];

    for (const [timestamp, values] of Object.entries(series)) {
      // Daily keys are dates; intraday keys are naive US/Eastern timestamps.
      const asOf = intraday
        ? new Date(`${timestamp.replace(' ', 'T')}Z`).toISOString()
        : new Date(`${timestamp}T00:00:00Z`).toISOString();
      const ms = Date.parse(asOf);
      if (ms < options.start.getTime() || ms > endMs) continue;

      const open = Number(values['1. open']);
      const high = Number(values['2. high']);
      const low = Number(values['3. low']);
      const close = Number(values['4. close']);
      const volume = Number(values['5. volume'] ?? values['6. volume'] ?? 0);
      if ([open, high, low, close].some((n) => !Number.isFinite(n))) continue;

      bars.push({
        symbol,
        timestamp: asOf,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
        interval,
        freshness: {
          asOf,
          retrievedAt,
          delayClass: intraday ? 'delayed_other' : 'end_of_day',
          feed: 'alpha_vantage',
        },
      });
    }

    bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return options.limit ? bars.slice(-options.limit) : bars;
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
      return { ...base, state: 'disabled', detail: 'ALPHA_VANTAGE_API_KEY not set' };
    }
    if (this.dailyQuota.remaining === 0) {
      return { ...base, state: 'degraded', detail: 'daily request budget exhausted' };
    }

    // A health check that burns 1 of 25 daily requests is itself a cost, so we
    // report configuration state rather than spending quota on a probe.
    return {
      ...base,
      state: 'healthy',
      detail: `configured; ${this.dailyQuota.remaining}/${this.dailyQuota.limit} requests left today (not probed to preserve quota)`,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
    };
  }

  getStats() {
    return { ...this.http.getStats(), dailyRemaining: this.dailyQuota.remaining };
  }
}
