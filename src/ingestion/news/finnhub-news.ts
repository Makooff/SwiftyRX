import type { Clock } from '../../core/clock.js';
import { systemClock } from '../../core/clock.js';
import { UpstreamError } from '../../core/errors.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type { HealthReport, NormalizedDocument } from '../../domain/types.js';
import { FINNHUB_NEWS_SOURCE, type FinnhubAdapter } from '../market_data/finnhub.js';
import type { DocumentSource, FetchWindow } from '../types.js';

/**
 * Finnhub company news as a document source.
 *
 * `FinnhubAdapter.fetchCompanyNews()` already existed and already produced
 * NormalizedDocument — it simply had no way into the pipeline, because the
 * adapter declares `kind: 'market_data'` and the ingestion stack only reads
 * `documentSources`. So the fetching is not reimplemented here; this is the
 * missing edge of the graph, not a second client.
 *
 * Why it matters: every feed running today publishes macro. Central bank and
 * statistics releases produce market-wide events, never a company catalyst, so
 * the model correctly answers WATCH and no order is ever placed. Company news
 * is the input that makes a directional signal possible at all — and therefore
 * the input that lets outcome tracking eventually say whether any of this works.
 */

/**
 * How many symbols to ask about per cycle.
 *
 * Not the whole watchlist. Finnhub's free tier allows 60 calls a minute and
 * that budget is shared with every quote the agent takes: forty news calls in
 * one pass would queue behind each other in the token bucket and starve the
 * prices, which are the one thing a cycle cannot proceed without. Eight per
 * cycle covers a forty-name watchlist in five minutes, which is well inside
 * the horizon of anything this system trades.
 */
const DEFAULT_SYMBOLS_PER_CYCLE = 8;

export interface FinnhubNewsOptions {
  adapter: FinnhubAdapter;
  /** Usually the watchlist. Empty means there is nothing to ask about. */
  symbols: string[];
  symbolsPerCycle?: number;
  clock?: Clock;
  logger?: Logger;
}

export class FinnhubNewsSource implements DocumentSource {
  readonly kind = 'news' as const;
  readonly id = 'finnhub_news';
  readonly requiresCredentials = true;
  readonly sources = [FINNHUB_NEWS_SOURCE];

  private readonly adapter: FinnhubAdapter;
  private readonly symbols: string[];
  private readonly symbolsPerCycle: number;
  private readonly log: Logger;
  private readonly clock: Clock;
  /** Where the next cycle resumes, so every symbol is reached in turn. */
  private cursor = 0;
  /**
   * What the last attempt actually did.
   *
   * A key being present is not a key being accepted. `FINNHUB_API_KEY=changeme`
   * is configured by every test this code can apply to a string, and 401s on
   * every call — so a probe that only asks "is it non-empty" reports healthy
   * while nothing works. That is the failure this system exists to make
   * impossible, so the probe reports what the calls did rather than what the
   * configuration says.
   */
  private lastAttempt?: { symbols: number; failures: number; error?: string; rejected: boolean };

  constructor(options: FinnhubNewsOptions) {
    this.adapter = options.adapter;
    this.symbols = options.symbols;
    this.symbolsPerCycle = options.symbolsPerCycle ?? DEFAULT_SYMBOLS_PER_CYCLE;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('finnhub-news');
  }

  isConfigured(): boolean {
    return this.adapter.isConfigured() && this.symbols.length > 0;
  }

  /** The symbols this cycle asks about, advancing the cursor for the next one. */
  private nextSlice(): string[] {
    if (this.symbols.length === 0) return [];
    const size = Math.min(this.symbolsPerCycle, this.symbols.length);
    const slice: string[] = [];
    for (let i = 0; i < size; i += 1) {
      slice.push(this.symbols[(this.cursor + i) % this.symbols.length]!);
    }
    this.cursor = (this.cursor + size) % this.symbols.length;
    return slice;
  }

  async fetchDocuments(window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    if (!this.isConfigured()) return [];

    const documents: NormalizedDocument[] = [];
    const slice = this.nextSlice();
    const attempt = { symbols: slice.length, failures: 0, rejected: false } as NonNullable<
      typeof this.lastAttempt
    >;

    for (const symbol of slice) {
      try {
        documents.push(...(await this.adapter.fetchCompanyNews(symbol, window)));
      } catch (error) {
        // One symbol failing must not cost the other seven. A rate limit or a
        // delisted ticker is an ordinary event here, not a reason to return
        // nothing and make the cycle look like a quiet news day.
        attempt.failures += 1;
        attempt.error = (error as Error).message;
        // 401 and 403 are not transient and not the symbol's fault: the key is
        // wrong. Worth separating, because "retry later" is the wrong advice.
        if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
          attempt.rejected = true;
        }
        this.log.warn(
          { symbol, error: (error as Error).message },
          'company news fetch failed for one symbol',
        );
      }
    }

    this.lastAttempt = attempt;
    return window.limit ? documents.slice(0, window.limit) : documents;
  }

  async health(): Promise<HealthReport> {
    const configured = this.adapter.isConfigured();
    const base = {
      adapter: this.id,
      kind: this.kind,
      checkedAt: this.clock.now().toISOString(),
      requiresCredentials: true,
      credentialsPresent: configured,
    };

    // Not configured, and not configurable: nobody asked for this source, so
    // it is off rather than broken.
    if (!configured) return { ...base, state: 'disabled', detail: 'FINNHUB_API_KEY not set' };
    if (this.symbols.length === 0) {
      return { ...base, state: 'disabled', detail: 'WATCHLIST is empty, so there is nothing to ask about' };
    }

    const attempt = this.lastAttempt;
    // Nothing tried yet. Reporting healthy here would be a guess; reporting
    // unavailable would be a false alarm on every fresh start.
    if (!attempt || attempt.symbols === 0) {
      return { ...base, state: 'degraded', detail: 'configured, no fetch attempted yet' };
    }

    if (attempt.rejected) {
      return {
        ...base,
        state: 'unavailable',
        detail: 'FINNHUB_API_KEY was rejected (401/403) — the key is present but not valid',
      };
    }
    if (attempt.failures === attempt.symbols) {
      return {
        ...base,
        state: 'unavailable',
        detail: `every symbol failed last cycle: ${attempt.error ?? 'unknown error'}`,
      };
    }
    if (attempt.failures > 0) {
      return {
        ...base,
        state: 'degraded',
        detail: `${attempt.failures} of ${attempt.symbols} symbol(s) failed: ${attempt.error ?? ''}`,
      };
    }

    return { ...base, state: 'healthy' };
  }
}
