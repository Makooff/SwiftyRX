import type { SourceTier } from '../domain/types.js';

/**
 * Curated feed catalogue.
 *
 * Only publicly documented RSS/Atom endpoints published by the organisation
 * itself. No scraping, no undocumented endpoints, no third-party mirrors.
 * URLs are verified in docs/API_RESEARCH.md; `verifiedOn` records when.
 *
 * Feeds are *not* enabled implicitly — `ENABLED_SOURCES` (or the defaults in
 * defaultEnabledFeeds()) decides what actually runs.
 */
export interface FeedDefinition {
  id: string;
  name: string;
  url: string;
  tier: SourceTier;
  category: 'official' | 'news';
  jurisdiction: string;
  /** Overrides the tier baseline when we have reason to be more/less trusting. */
  reliability?: number;
  licenceNote?: string;
  /** Feeds a European retail user can rely on without a US-only entitlement. */
  notes?: string;
}

export const OFFICIAL_FEEDS: FeedDefinition[] = [
  {
    id: 'ecb_press',
    name: 'European Central Bank — Press releases',
    url: 'https://www.ecb.europa.eu/rss/press.html',
    tier: 'official',
    category: 'official',
    jurisdiction: 'EU',
    licenceNote: 'ECB permits reuse with attribution; see ECB copyright notice.',
  },
  {
    id: 'ecb_monetary_policy',
    name: 'European Central Bank — Monetary policy decisions',
    url: 'https://www.ecb.europa.eu/rss/pressdec.html',
    tier: 'official',
    category: 'official',
    jurisdiction: 'EU',
  },
  {
    id: 'federalreserve_press_monetary',
    name: 'Federal Reserve — Monetary policy press releases',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
    tier: 'official',
    category: 'official',
    jurisdiction: 'US',
    licenceNote: 'US federal government work; generally public domain.',
  },
  {
    id: 'federalreserve_press_all',
    name: 'Federal Reserve — All press releases',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    tier: 'official',
    category: 'official',
    jurisdiction: 'US',
  },
  {
    id: 'sec_press',
    name: 'SEC — Press releases',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    tier: 'official',
    category: 'official',
    jurisdiction: 'US',
    notes: 'Requires the SEC User-Agent header like every sec.gov endpoint.',
  },
  {
    id: 'bls_news',
    name: 'US Bureau of Labor Statistics — News releases',
    url: 'https://www.bls.gov/feed/bls_latest.rss',
    tier: 'official',
    category: 'official',
    jurisdiction: 'US',
  },
  {
    id: 'nbb_press',
    name: 'National Bank of Belgium — Press releases',
    url: 'https://www.nbb.be/en/rss/press-releases',
    tier: 'official',
    category: 'official',
    jurisdiction: 'BE',
    notes: 'Local relevance for a Belgium-based operator; verify feed liveness on first run.',
  },
];

export const NEWS_FEEDS: FeedDefinition[] = [
  {
    id: 'reuters_business_via_google',
    name: 'Google News — Reuters business (aggregated)',
    url: 'https://news.google.com/rss/search?q=when:24h+allinurl:reuters.com&hl=en-US&gl=US&ceid=US:en',
    tier: 'aggregator',
    category: 'news',
    jurisdiction: 'GLOBAL',
    reliability: 0.45,
    licenceNote:
      'Google News RSS is undocumented as a public API and returns headlines/links only. Treat as a discovery hint, never as a primary source.',
    notes: 'Disabled by default. Prefer a licensed news API before relying on this.',
  },
  {
    id: 'cnbc_finance',
    name: 'CNBC — Finance',
    url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
    tier: 'news',
    category: 'news',
    jurisdiction: 'US',
    licenceNote: 'Publisher RSS; headline + summary only. Do not redistribute full text.',
  },
  {
    id: 'ft_markets',
    name: 'Financial Times — Markets',
    url: 'https://www.ft.com/markets?format=rss',
    tier: 'news',
    category: 'news',
    jurisdiction: 'UK',
    licenceNote: 'Headlines only without a subscription; full text is paywalled.',
  },
];

export const ALL_FEEDS: FeedDefinition[] = [...OFFICIAL_FEEDS, ...NEWS_FEEDS];

/**
 * Feeds enabled when the operator has not chosen explicitly.
 *
 * Official sources only: they are free, stable, licence-clear, and they are
 * the tier the verification pipeline actually needs.
 */
export function defaultEnabledFeeds(): FeedDefinition[] {
  return OFFICIAL_FEEDS;
}

export function selectFeeds(enabledIds: string[]): FeedDefinition[] {
  if (enabledIds.length === 0) return defaultEnabledFeeds();
  const byId = new Map(ALL_FEEDS.map((f) => [f.id, f]));
  return enabledIds.map((id) => byId.get(id)).filter((f): f is FeedDefinition => f !== undefined);
}
