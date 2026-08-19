import type { Entity, NormalizedDocument, VerificationStatus } from '../domain/types.js';

/**
 * Phase 2 domain: events and their verification state.
 *
 * Everything here is produced by deterministic, auditable rules. No LLM is
 * involved — that arrives in Phase 3 and will *refine* these structures, not
 * replace them. Keeping a rule-based layer underneath means there is always a
 * reproducible answer to "why did the system think this?", independent of a
 * model's mood.
 */

export type EventType =
  // Filing-derived (high precision: the form and item codes say what it is)
  | 'earnings'
  | 'periodic_report'
  | 'material_agreement'
  | 'm_and_a'
  | 'executive_change'
  | 'ownership_change'
  | 'insider_transaction'
  | 'accounting_issue'
  | 'bankruptcy'
  | 'restructuring'
  | 'listing_status'
  | 'disclosure'
  // Text-derived (lower precision)
  | 'monetary_policy'
  | 'macro_release'
  | 'trade_policy'
  | 'sanctions'
  | 'legal_action'
  | 'guidance'
  | 'product'
  | 'unclassified';

/**
 * Prior materiality per event type, in [0,1].
 *
 * "How much does an event of this kind typically matter to a price?" — not
 * "how much does this specific one matter", which needs the content itself.
 * Conservative by design: nothing here reaches 1.0.
 */
export const EVENT_TYPE_MATERIALITY: Record<EventType, number> = {
  monetary_policy: 0.9,
  earnings: 0.85,
  m_and_a: 0.85,
  bankruptcy: 0.85,
  accounting_issue: 0.8,
  macro_release: 0.75,
  trade_policy: 0.75,
  sanctions: 0.7,
  guidance: 0.7,
  legal_action: 0.6,
  executive_change: 0.55,
  restructuring: 0.55,
  ownership_change: 0.5,
  listing_status: 0.5,
  material_agreement: 0.45,
  periodic_report: 0.4,
  insider_transaction: 0.35,
  product: 0.3,
  disclosure: 0.25,
  unclassified: 0.1,
};

export interface RuleMatch {
  /** Rule identifier, e.g. "sec:item:2.02" or "kw:monetary_policy". */
  rule: string;
  type: EventType;
  weight: number;
  /** The text that triggered it, for auditing. */
  evidence?: string;
}

export interface Classification {
  type: EventType;
  /** Confidence in the *classification*, not in the claim's truth. */
  confidence: number;
  matched: RuleMatch[];
}

export interface MarketReaction {
  symbol: string;
  windowStart: string;
  windowEnd: string;
  /** Close-to-close return across the window, in percent. */
  returnPct: number;
  /** Window volume divided by the trailing average. */
  volumeRatio: number;
  abnormal: boolean;
  provider: string;
  /**
   * Recorded because the brief's verification chain asks for it, with a
   * standing caveat: a price move confirms that the market reacted to
   * *something*, never that a claim is true.
   */
  note: string;
}

export interface Contradiction {
  documentId: string;
  source: string;
  /** The phrase that indicated a denial or retraction. */
  excerpt: string;
  matchedPattern: string;
}

export interface VerificationAssessment {
  status: VerificationStatus;
  /** Confidence that the claim is true, in [0,1]. Not a trading signal. */
  confidence: number;
  /** Number of distinct source ids reporting the event. */
  distinctSources: number;
  /**
   * Documents that are not near-duplicates of another in the cluster.
   * Syndicated republication of one newsroom's copy is one report, not two,
   * however many outlets carry it.
   */
  independentReports: number;
  authoritativeSources: string[];
  contradictions: Contradiction[];
  marketReaction?: MarketReaction;
  /** Human-readable trace of every rule that moved the number. */
  reasons: string[];
}

/** A document behind an event, as something a person can open. */
export interface EventLink {
  source: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

export interface MarketEvent {
  id: string;
  type: EventType;
  headline: string;
  summary: string;
  /** Earliest publication time across the cluster. */
  firstSeenAt: string;
  lastUpdatedAt: string;
  entities: Entity[];
  tickers: string[];
  /** Jurisdictions implicated (ISO-3166 alpha-2, "EU", or "GLOBAL"). */
  jurisdictions: string[];
  documentIds: string[];
  sources: string[];
  /**
   * Where to read the thing itself.
   *
   * The event is our summary of a cluster of documents; these are the
   * documents. Without them the dashboard can state that a filing was
   * detected and offer no way to check whether the reading was right, which
   * makes every judgement here unfalsifiable from the outside.
   *
   * One entry per distinct URL, capped — a cluster of forty syndications of
   * one story is one story, and storing forty links would say otherwise.
   */
  links: EventLink[];
  classification: Classification;
  /** Prior importance in [0,1], before any claim-level verification. */
  materiality: number;
  verification: VerificationAssessment;
}

/** A cluster of documents believed to describe one event. */
export interface EventCluster {
  id: string;
  type: EventType;
  documents: NormalizedDocument[];
  entities: Entity[];
  tickers: string[];
  jurisdictions: string[];
  firstSeenAt: string;
  lastUpdatedAt: string;
  classifications: Classification[];
}
