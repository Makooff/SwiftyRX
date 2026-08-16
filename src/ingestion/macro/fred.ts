import { type Clock, systemClock } from '../../core/clock.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
import type {
  AdapterKind,
  HealthReport,
  MacroObservation,
  SourceDescriptor,
} from '../../domain/types.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { MacroSource } from '../types.js';

/**
 * FRED adapter (Federal Reserve Bank of St. Louis).
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - Free API key, instant self-service registration.
 *  - 120 requests/minute per key.
 *  - Available worldwide, including Belgium.
 *  - Some third-party series carry redistribution restrictions.
 *
 * Point-in-time correctness: FRED exposes vintages via `realtime_start` /
 * `realtime_end`. `getSeriesAsOf()` uses them so a backtest sees the numbers as
 * they stood on the decision date, not the later revised values. Using the
 * default (latest-vintage) call inside a backtest is a look-ahead bug.
 */

const FRED_REQUESTS_PER_MINUTE = 120;

interface FredObservationsResponse {
  observations?: Array<{
    date: string;
    value: string;
    realtime_start?: string;
    realtime_end?: string;
  }>;
}

interface FredSeriesResponse {
  seriess?: Array<{
    id: string;
    title: string;
    units?: string;
    frequency?: string;
    last_updated?: string;
  }>;
}

/** Series commonly used for macro context. Not exhaustive. */
export const FRED_SERIES = {
  fedFundsRate: 'DFF',
  cpiUrban: 'CPIAUCSL',
  unemploymentRate: 'UNRATE',
  realGdp: 'GDPC1',
  tenYearYield: 'DGS10',
  twoYearYield: 'DGS2',
  vix: 'VIXCLS',
  eurUsd: 'DEXUSEU',
} as const;

export const FRED_SOURCE: SourceDescriptor = describeSource({
  id: 'fred',
  name: 'FRED — Federal Reserve Bank of St. Louis',
  tier: 'official',
  jurisdiction: 'US',
  url: 'https://fred.stlouisfed.org',
  licenceNote:
    'Free with API key. Redistribution of some third-party series (e.g. S&P/Case-Shiller) is restricted by the originating provider.',
});

export interface FredOptions {
  apiKey?: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  userAgent?: string;
}

export class FredAdapter implements MacroSource {
  readonly kind = 'macro' as const;
  readonly id = 'fred';
  readonly requiresCredentials = true;
  readonly sources = [FRED_SOURCE];

  private readonly http: HttpClient;
  private readonly apiKey?: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private lastSuccessAt?: string;

  constructor(options: FredOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('fred');
    if (options.apiKey) {
      this.apiKey = options.apiKey;
      registerSecret(options.apiKey);
    }
    sourceRegistry.register(FRED_SOURCE);

    this.http = new HttpClient({
      name: 'fred',
      baseUrl: 'https://api.stlouisfed.org/fred/',
      ...(options.userAgent ? { defaultHeaders: { 'user-agent': options.userAgent } } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(FRED_REQUESTS_PER_MINUTE, this.clock),
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) throw new Error('FRED_API_KEY is not configured');
    return this.apiKey;
  }

  private toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  async getSeries(
    seriesId: string,
    options: { start?: Date; end?: Date; limit?: number } = {},
  ): Promise<MacroObservation[]> {
    return this.fetchObservations(seriesId, options);
  }

  /**
   * Point-in-time query: values as they were published on `asOf`.
   * This is the call backtests must use.
   */
  async getSeriesAsOf(
    seriesId: string,
    asOf: Date,
    options: { start?: Date; limit?: number } = {},
  ): Promise<MacroObservation[]> {
    const vintage = this.toIsoDate(asOf);
    return this.fetchObservations(seriesId, {
      ...options,
      end: asOf,
      realtimeStart: vintage,
      realtimeEnd: vintage,
    });
  }

  private async fetchObservations(
    seriesId: string,
    options: {
      start?: Date;
      end?: Date;
      limit?: number;
      realtimeStart?: string;
      realtimeEnd?: string;
    },
  ): Promise<MacroObservation[]> {
    const payload = await this.http.getJson<FredObservationsResponse>('series/observations', {
      query: {
        series_id: seriesId,
        api_key: this.requireKey(),
        file_type: 'json',
        sort_order: 'desc',
        ...(options.start ? { observation_start: this.toIsoDate(options.start) } : {}),
        ...(options.end ? { observation_end: this.toIsoDate(options.end) } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.realtimeStart ? { realtime_start: options.realtimeStart } : {}),
        ...(options.realtimeEnd ? { realtime_end: options.realtimeEnd } : {}),
      },
    });

    const retrievedAt = this.clock.now().toISOString();
    this.lastSuccessAt = retrievedAt;

    return (payload.observations ?? []).map((obs) => ({
      seriesId,
      date: obs.date,
      // FRED encodes missing values as ".", which must stay null rather than
      // silently becoming 0.
      value: obs.value === '.' || obs.value === '' ? null : Number(obs.value),
      source: FRED_SOURCE.id,
      ...(obs.realtime_start ? { releasedAt: obs.realtime_start } : {}),
      freshness: {
        asOf: obs.date,
        retrievedAt,
        delayClass: 'end_of_day',
        feed: 'fred',
      },
    }));
  }

  async getSeriesInfo(seriesId: string): Promise<{ title: string; units?: string; frequency?: string } | undefined> {
    const payload = await this.http.getJson<FredSeriesResponse>('series', {
      query: { series_id: seriesId, api_key: this.requireKey(), file_type: 'json' },
    });
    const series = payload.seriess?.[0];
    if (!series) return undefined;
    return {
      title: series.title,
      ...(series.units ? { units: series.units } : {}),
      ...(series.frequency ? { frequency: series.frequency } : {}),
    };
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
      return { ...base, state: 'disabled', detail: 'FRED_API_KEY not set' };
    }

    const startedAt = this.clock.nowMs();
    try {
      const obs = await this.getSeries(FRED_SERIES.fedFundsRate, { limit: 1 });
      return {
        ...base,
        state: obs.length > 0 ? 'healthy' : 'degraded',
        ...(obs.length === 0 ? { detail: 'query returned no observations' } : {}),
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
