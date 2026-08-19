import type { AppConfig } from '../config/env.js';
import { type Clock, systemClock } from '../core/clock.js';
import type { FetchImpl } from '../core/http.js';
import { createLogger, type Logger } from '../core/logger.js';
import type { HealthReport, NormalizedDocument } from '../domain/types.js';
import { Metrics, metrics as globalMetrics } from '../monitoring/metrics.js';
import { Deduplicator } from './dedup.js';
import { ALL_FEEDS, selectFeedsDetailed } from './feeds.js';
import { EcbAdapter } from './macro/ecb.js';
import { FredAdapter } from './macro/fred.js';
import { AlpacaMarketDataAdapter } from './market_data/alpaca.js';
import { AlphaVantageAdapter } from './market_data/alpha-vantage.js';
import { FinnhubAdapter } from './market_data/finnhub.js';
import { FinnhubNewsSource } from './news/finnhub-news.js';
import { FixtureMarketDataAdapter } from './market_data/fixture.js';
import { MarketDataService } from './market_data/index.js';
import { RssAdapter } from './news/rss.js';
import { SecEdgarAdapter } from './official_sources/sec-edgar.js';
import { XAdapter } from './social/x.js';
import type { Adapter, DocumentSource, MacroSource, MarketDataSource } from './types.js';

/**
 * Ingestion wiring.
 *
 * Builds the adapter set from configuration. Everything unconfigured is left
 * out rather than half-enabled, so `sources:check` reports exactly what the
 * system can actually see.
 */

export interface IngestionStack {
  documentSources: DocumentSource[];
  macroSources: MacroSource[];
  marketData: MarketDataService;
  adapters: Adapter[];
  deduplicator: Deduplicator;
}

export interface BuildOptions {
  clock?: Clock;
  logger?: Logger;
  /** Test seam: a fixture-backed fetch. */
  fetchImpl?: FetchImpl;
  /** Include the synthetic market-data provider (development only). */
  includeFixtureMarketData?: boolean;
}

export function buildIngestionStack(config: AppConfig, options: BuildOptions = {}): IngestionStack {
  const clock = options.clock ?? systemClock;
  const log = options.logger ?? createLogger('ingestion');
  const shared = {
    clock,
    timeoutMs: config.HTTP_TIMEOUT_MS,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  // --- Documents ----------------------------------------------------------
  const { feeds, unknownIds } = selectFeedsDetailed(config.ENABLED_SOURCES);
  const officialFeeds = feeds.filter((f) => f.category === 'official');
  const newsFeeds = feeds.filter((f) => f.category === 'news');

  if (unknownIds.length > 0) {
    // Loud, because the symptom of a mistyped id is fewer documents, which
    // is indistinguishable from a quiet news day.
    log.warn(
      { unknownIds, known: ALL_FEEDS.map((f) => f.id) },
      'ENABLED_SOURCES names feeds that do not exist — they are NOT running',
    );
  }

  const documentSources: DocumentSource[] = [];

  if (officialFeeds.length > 0) {
    documentSources.push(
      new RssAdapter('official_rss', { feeds: officialFeeds, userAgent: config.userAgent, ...shared }),
    );
  }
  if (newsFeeds.length > 0) {
    documentSources.push(
      new RssAdapter('news_rss', { feeds: newsFeeds, userAgent: config.userAgent, ...shared }),
    );
  }

  const sec = new SecEdgarAdapter({
    userAgent: config.userAgent,
    ...(config.CONTACT_EMAIL ? { contactEmail: config.CONTACT_EMAIL } : {}),
    tickers: config.WATCHLIST,
    ...shared,
  });
  if (sec.isConfigured()) {
    documentSources.push(sec);
  } else {
    log.warn({}, 'SEC EDGAR disabled: set CONTACT_EMAIL (the SEC requires it in the User-Agent)');
  }

  const x = new XAdapter({
    enabled: config.ENABLE_X_INGESTION,
    ...(config.X_BEARER_TOKEN ? { bearerToken: config.X_BEARER_TOKEN } : {}),
    watchedAccounts: config.X_WATCHED_ACCOUNTS,
    maxPostsReadPerDay: config.X_MAX_POSTS_READ_PER_DAY,
    ...shared,
  });
  if (x.isConfigured()) documentSources.push(x);

  // --- Macro --------------------------------------------------------------
  const macroSources: MacroSource[] = [new EcbAdapter({ userAgent: config.userAgent, ...shared })];
  const fred = new FredAdapter({
    ...(config.FRED_API_KEY ? { apiKey: config.FRED_API_KEY } : {}),
    userAgent: config.userAgent,
    ...shared,
  });
  if (fred.isConfigured()) macroSources.push(fred);

  // --- Market data --------------------------------------------------------
  // One instance, shared with the company-news source below. Two would mean two
  // token buckets against one 60-calls-a-minute account, which is the same as
  // having none.
  const finnhub = new FinnhubAdapter({
    ...(config.FINNHUB_API_KEY ? { apiKey: config.FINNHUB_API_KEY } : {}),
    ...shared,
  });

  // Company news: the only configured source that produces company-specific
  // events rather than macro. Everything else running today publishes rate
  // decisions and statistics, which cannot carry a company catalyst.
  const finnhubNews = new FinnhubNewsSource({
    adapter: finnhub,
    symbols: config.WATCHLIST,
    clock,
    logger: log,
  });
  if (finnhubNews.isConfigured()) documentSources.push(finnhubNews);

  // Ordered by priority: real-time feed first, EOD fallbacks after.
  const marketProviders: MarketDataSource[] = [
    new AlpacaMarketDataAdapter({
      ...(config.ALPACA_API_KEY_ID ? { apiKeyId: config.ALPACA_API_KEY_ID } : {}),
      ...(config.ALPACA_API_SECRET_KEY ? { apiSecretKey: config.ALPACA_API_SECRET_KEY } : {}),
      feed: config.ALPACA_DATA_FEED,
      ...shared,
    }),
    finnhub,
    new AlphaVantageAdapter({
      ...(config.ALPHA_VANTAGE_API_KEY ? { apiKey: config.ALPHA_VANTAGE_API_KEY } : {}),
      ...shared,
    }),
  ];

  if (options.includeFixtureMarketData) {
    // Last resort, development only: synthetic prices must never outrank a
    // real feed.
    marketProviders.push(new FixtureMarketDataAdapter({ clock }));
  }

  const marketData = new MarketDataService({
    providers: marketProviders,
    maxStalenessSeconds: config.MAX_QUOTE_STALENESS_SECONDS,
    clock,
    logger: log,
  });

  const adapters: Adapter[] = [...documentSources, ...macroSources, ...marketProviders];

  return {
    documentSources,
    macroSources,
    marketData,
    adapters,
    deduplicator: new Deduplicator({ clock }),
  };
}

export interface IngestionCycleResult {
  documents: NormalizedDocument[];
  stats: {
    fetched: number;
    kept: number;
    exactDuplicates: number;
    nearDuplicates: number;
    bySource: Record<string, number>;
    failures: Array<{ adapter: string; error: string }>;
    durationMs: number;
  };
}

/**
 * One ingestion pass: fetch -> normalise -> dedup.
 *
 * Adapters run concurrently and failures are isolated: a broken feed degrades
 * coverage, it does not stop the cycle. Downstream phases decide what missing
 * coverage means for tradeability.
 */
export async function runIngestionCycle(
  stack: IngestionStack,
  options: { since?: Date; limitPerSource?: number; clock?: Clock; metrics?: Metrics } = {},
): Promise<IngestionCycleResult> {
  const clock = options.clock ?? systemClock;
  const m = options.metrics ?? globalMetrics;
  const startedAt = clock.nowMs();
  const failures: Array<{ adapter: string; error: string }> = [];

  const settled = await Promise.allSettled(
    stack.documentSources.map((source) =>
      m.time(
        'ingestion.fetch',
        () =>
          source.fetchDocuments({
            ...(options.since ? { since: options.since } : {}),
            ...(options.limitPerSource ? { limit: options.limitPerSource } : {}),
          }),
        { adapter: source.id },
      ),
    ),
  );

  const fetched: NormalizedDocument[] = [];
  settled.forEach((result, index) => {
    const adapterId = stack.documentSources[index]?.id ?? 'unknown';
    if (result.status === 'fulfilled') {
      fetched.push(...result.value);
    } else {
      failures.push({ adapter: adapterId, error: String(result.reason) });
      m.increment('ingestion.adapter_failure', 1, { adapter: adapterId });
    }
  });

  const { kept, results } = stack.deduplicator.process(fetched);
  const exactDuplicates = results.filter((r) => r.status === 'exact_duplicate').length;
  const nearDuplicates = results.filter((r) => r.status === 'near_duplicate').length;

  const bySource: Record<string, number> = {};
  for (const doc of kept) bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;

  m.increment('ingestion.documents_fetched', fetched.length);
  m.increment('ingestion.documents_kept', kept.length);
  m.increment('ingestion.duplicates_dropped', exactDuplicates);

  return {
    documents: kept,
    stats: {
      fetched: fetched.length,
      kept: kept.length,
      exactDuplicates,
      nearDuplicates,
      bySource,
      failures,
      durationMs: clock.nowMs() - startedAt,
    },
  };
}

/** Health for every adapter in the stack. Never throws. */
export async function checkStackHealth(stack: IngestionStack): Promise<HealthReport[]> {
  const results = await Promise.allSettled(stack.adapters.map((a) => a.health()));
  return results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const adapter = stack.adapters[index];
    return {
      adapter: adapter?.id ?? 'unknown',
      kind: adapter?.kind ?? 'news',
      state: 'unavailable' as const,
      detail: `health check threw: ${String(result.reason)}`,
      checkedAt: new Date().toISOString(),
      requiresCredentials: adapter?.requiresCredentials ?? false,
      credentialsPresent: adapter?.isConfigured() ?? false,
    };
  });
}
