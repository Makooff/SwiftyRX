import { ageSeconds, type Clock, systemClock } from '../../core/clock.js';
import { StaleDataError } from '../../core/errors.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type { Bar, BarInterval, HealthReport, Quote } from '../../domain/types.js';
import type { MarketDataSource } from '../types.js';

export { AlpacaMarketDataAdapter } from './alpaca.js';
export { AlphaVantageAdapter } from './alpha-vantage.js';
export { FinnhubAdapter } from './finnhub.js';
export { FixtureMarketDataAdapter } from './fixture.js';

/**
 * Market data service: provider failover plus the staleness guard.
 *
 * Two rules, both non-negotiable downstream:
 *  - A quote older than `maxStalenessSeconds` is not returned. It raises
 *    StaleDataError, which the Risk Engine turns into DO NOT TRADE. Serving
 *    an old price with a shrug is how a system trades on a phantom market.
 *  - Providers are tried in configured priority order; every fallback is
 *    logged, because silently degrading to a worse feed is a decision the
 *    operator deserves to see.
 */

export interface MarketDataServiceOptions {
  providers: MarketDataSource[];
  maxStalenessSeconds: number;
  clock?: Clock;
  logger?: Logger;
}

export interface QuoteResult {
  quote: Quote;
  provider: string;
  ageSeconds: number;
  /** Providers that failed before this one succeeded. */
  fallbacksUsed: string[];
}

export class MarketDataService {
  private readonly providers: MarketDataSource[];
  private readonly maxStalenessSeconds: number;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(options: MarketDataServiceOptions) {
    this.providers = options.providers.filter((p) => p.isConfigured());
    this.maxStalenessSeconds = options.maxStalenessSeconds;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('market-data');

    if (this.providers.length === 0) {
      this.log.warn({}, 'no market data provider is configured');
    }
  }

  get configuredProviders(): string[] {
    return this.providers.map((p) => p.id);
  }

  /**
   * Fresh quote from the highest-priority provider that can supply one.
   *
   * @throws StaleDataError when every provider is unavailable or too stale.
   */
  async getQuote(symbol: string, options: { maxStalenessSeconds?: number } = {}): Promise<QuoteResult> {
    const limit = options.maxStalenessSeconds ?? this.maxStalenessSeconds;
    const fallbacksUsed: string[] = [];
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        const quote = await provider.getQuote(symbol);
        const age = ageSeconds(quote.freshness.asOf, this.clock);

        if (age > limit) {
          failures.push(`${provider.id}: stale by ${Math.round(age)}s`);
          fallbacksUsed.push(provider.id);
          this.log.warn(
            { provider: provider.id, symbol, ageSeconds: Math.round(age), limit },
            'quote too stale, trying next provider',
          );
          continue;
        }

        return { quote, provider: provider.id, ageSeconds: age, fallbacksUsed };
      } catch (err) {
        failures.push(`${provider.id}: ${(err as Error).message}`);
        fallbacksUsed.push(provider.id);
        this.log.warn(
          { provider: provider.id, symbol, error: (err as Error).message },
          'quote fetch failed, trying next provider',
        );
      }
    }

    throw new StaleDataError(
      `No usable quote for ${symbol} within ${limit}s — DO NOT TRADE`,
      Number.POSITIVE_INFINITY,
      limit,
      { symbol, attempts: failures },
    );
  }

  /** Historical bars from the first provider that returns any. */
  async getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<{ bars: Bar[]; provider: string }> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        const bars = await provider.getBars(symbol, interval, options);
        if (bars.length > 0) return { bars, provider: provider.id };
        failures.push(`${provider.id}: empty result`);
      } catch (err) {
        failures.push(`${provider.id}: ${(err as Error).message}`);
      }
    }

    throw new StaleDataError(
      `No historical bars for ${symbol} (${interval}) from any provider`,
      Number.POSITIVE_INFINITY,
      0,
      { symbol, interval, attempts: failures },
    );
  }

  async health(): Promise<HealthReport[]> {
    return Promise.all(this.providers.map((provider) => provider.health()));
  }
}
