/**
 * Domain contracts shared across the pipeline.
 *
 * Everything ingestion produces is expressed in these types, so downstream
 * phases (event detection, LLM analysis, scoring, risk) never depend on a
 * specific vendor's payload shape.
 */

/**
 * How much inherent trust a source class carries. This is *not* a measure of
 * whether a given claim is true — that is what VerificationStatus is for.
 */
export type SourceTier =
  | 'official' // central banks, governments, regulators, issuer IR
  | 'regulatory_filing' // SEC/EDGAR and equivalents
  | 'exchange' // exchange / market-data operator
  | 'wire' // primary newswire
  | 'news' // reputable financial press
  | 'aggregator' // syndicators, feeds of feeds
  | 'social' // X and similar
  | 'unknown';

/** Baseline prior reliability per tier, in [0,1]. Overridable per source. */
export const TIER_BASE_RELIABILITY: Record<SourceTier, number> = {
  official: 0.98,
  regulatory_filing: 0.97,
  exchange: 0.95,
  wire: 0.85,
  news: 0.7,
  aggregator: 0.5,
  social: 0.25,
  unknown: 0.1,
};

export interface SourceDescriptor {
  /** Stable machine id, e.g. "sec_edgar", "ecb_press", "x:@handle". */
  id: string;
  name: string;
  tier: SourceTier;
  /** Prior reliability in [0,1]; defaults to the tier baseline. */
  reliability: number;
  /** Home country/region of the publisher, ISO-3166 alpha-2 or "EU"/"GLOBAL". */
  jurisdiction?: string;
  url?: string;
  /** True when this source can, on its own, confirm a claim as official. */
  authoritative: boolean;
  /** Terms/licence note — relevant because several providers ban commercial use. */
  licenceNote?: string;
}

/**
 * Verification state of a claim.
 *
 * A document never jumps straight to a trade. Phase 2 assigns and updates this
 * as corroborating or contradicting evidence arrives.
 */
export type VerificationStatus =
  | 'unverified'
  | 'corroborated'
  | 'officially_confirmed'
  | 'contradicted';

export type EntityType = 'company' | 'ticker' | 'person' | 'country' | 'sector' | 'currency' | 'other';

export interface Entity {
  type: EntityType;
  /** Surface form as it appeared in the text. */
  text: string;
  /** Resolved identifier when known (ticker, ISO country code, CIK...). */
  id?: string;
  confidence: number;
}

/** Exactly what an adapter received, before any interpretation. */
export interface RawDocument {
  sourceId: string;
  /** Provider-native identifier, used for exact dedup. */
  externalId?: string;
  url?: string;
  title?: string;
  content?: string;
  publishedAt?: string;
  retrievedAt: string;
  /** Untouched provider payload, for audit and replay. */
  raw: unknown;
}

/**
 * Normalised document — the canonical unit flowing through the pipeline.
 *
 * Field names mirror the ingestion record format specified for this project.
 */
export interface NormalizedDocument {
  id: string;
  source: string;
  sourceTier: SourceTier;
  source_reliability: number;
  url: string | null;
  title: string;
  content: string;
  /** Publisher timestamp (ISO-8601 UTC). Null when the source omits one. */
  published_at: string | null;
  /** When *we* obtained it. Used for look-ahead-safe replay. */
  retrieved_at: string;
  language?: string;
  entities: Entity[];
  /** Tickers explicitly referenced by the source (not inferred). */
  tickers: string[];
  /** sha256 over normalised title+content: exact-duplicate identity. */
  contentHash: string;
  /** Set once dedup links this to an earlier document about the same fact. */
  duplicateOf?: string;
  verification: VerificationStatus;
  /** Free-form provider metadata that downstream phases may use. */
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * Freshness envelope.
 *
 * Every market-data value carries the time it refers to and the delay class of
 * the feed it came from. The Risk Engine refuses to trade on stale or unknown
 * -provenance data, so this metadata is mandatory, not decorative.
 */
export interface Freshness {
  /** Timestamp the data refers to. */
  asOf: string;
  /** When we retrieved it. */
  retrievedAt: string;
  /** Documented delay class of the feed. */
  delayClass: 'realtime' | 'delayed_15m' | 'delayed_other' | 'end_of_day' | 'unknown';
  /** Feed identifier, e.g. "alpaca:iex", "finnhub:us". */
  feed: string;
}

export interface Quote {
  symbol: string;
  bid?: number;
  ask?: number;
  /** Last traded price, when the feed provides one. */
  last?: number;
  bidSize?: number;
  askSize?: number;
  currency: string;
  freshness: Freshness;
}

export type BarInterval = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

export interface Bar {
  symbol: string;
  /** Bar open time (ISO-8601 UTC). */
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Volume-weighted average price, when provided. */
  vwap?: number;
  tradeCount?: number;
  interval: BarInterval;
  freshness: Freshness;
}

// ---------------------------------------------------------------------------
// Macro
// ---------------------------------------------------------------------------

export interface MacroObservation {
  seriesId: string;
  /** Human-readable series title from the provider. */
  title?: string;
  /** Period the observation refers to (ISO date). */
  date: string;
  value: number | null;
  units?: string;
  frequency?: string;
  source: string;
  /**
   * Release timestamp when the provider exposes one. Backtests must key on
   * this, not on `date`, or they leak future information.
   */
  releasedAt?: string;
  freshness: Freshness;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthState = 'healthy' | 'degraded' | 'unavailable' | 'disabled';

export interface HealthReport {
  adapter: string;
  kind: AdapterKind;
  state: HealthState;
  /** Why it is not healthy, when applicable. */
  detail?: string;
  checkedAt: string;
  latencyMs?: number;
  /** Timestamp of the most recent successful data retrieval. */
  lastSuccessAt?: string;
  requiresCredentials: boolean;
  credentialsPresent: boolean;
}

export type AdapterKind = 'news' | 'official' | 'macro' | 'market_data' | 'social';
