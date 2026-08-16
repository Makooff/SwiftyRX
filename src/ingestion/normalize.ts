import { type Clock, systemClock } from '../core/clock.js';
import { contentHash, sha256 } from '../core/hash.js';
import type { Entity, NormalizedDocument, RawDocument } from '../domain/types.js';
import { sourceRegistry } from './source-registry.js';

/**
 * Normalisation: RawDocument -> NormalizedDocument.
 *
 * Deliberately conservative. It cleans and structures; it does not interpret.
 * Any inference about meaning belongs to Phase 2/3 where it can be audited.
 */

/** Strip HTML/CDATA and collapse whitespace, without pulling in a parser. */
export function stripHtml(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a publisher timestamp to ISO-8601 UTC, or null when unusable. */
export function toIsoOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (Number.isNaN(ms)) return null;
  // Providers vary between seconds and milliseconds epochs.
  const normalised = typeof value === 'number' && value < 1e12 ? value * 1000 : ms;
  const date = new Date(normalised);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Extract ticker candidates that the *source itself* marked up (e.g. "$NVDA"
 * or "(NASDAQ: NVDA)"). Free-text company-name resolution is Phase 2's job.
 */
export function extractExplicitTickers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\$([A-Z]{1,5})\b/g)) {
    if (match[1]) found.add(match[1]);
  }
  for (const match of text.matchAll(
    /\((?:NASDAQ|NYSE|AMEX|NYSEARCA|OTC|EURONEXT|LSE|XETRA)\s*:\s*([A-Z.]{1,6})\)/gi,
  )) {
    if (match[1]) found.add(match[1].toUpperCase());
  }
  return [...found];
}

export interface NormalizeOptions {
  clock?: Clock;
  /** Tickers the adapter knows apply (e.g. the symbol the feed was queried for). */
  declaredTickers?: string[];
  entities?: Entity[];
  language?: string;
  metadata?: Record<string, unknown>;
}

export function normalizeDocument(
  raw: RawDocument,
  options: NormalizeOptions = {},
): NormalizedDocument {
  const clock: Clock = options.clock ?? systemClock;
  const title = stripHtml(raw.title ?? '').slice(0, 500);
  const content = stripHtml(raw.content ?? '');
  const tier = sourceRegistry.tierOf(raw.sourceId);
  const reliability = sourceRegistry.reliabilityOf(raw.sourceId);

  const declared = (options.declaredTickers ?? []).map((t) => t.toUpperCase());
  const tickers = [...new Set([...declared, ...extractExplicitTickers(`${title} ${content}`)])];

  const hash = contentHash([title, content.slice(0, 4000)]);
  // Identity is source-scoped: the same wire story republished by two outlets
  // is two documents, and cross-source sameness is dedup's problem.
  const id = sha256([raw.sourceId, raw.externalId ?? raw.url ?? hash].join('|')).slice(0, 32);

  return {
    id,
    source: raw.sourceId,
    sourceTier: tier,
    source_reliability: reliability,
    url: raw.url ?? null,
    title,
    content,
    published_at: toIsoOrNull(raw.publishedAt),
    retrieved_at: raw.retrievedAt || clock.now().toISOString(),
    ...(options.language ? { language: options.language } : {}),
    entities: options.entities ?? [],
    tickers,
    contentHash: hash,
    // Every document starts unverified, including official ones: confirmation
    // is established by the verification pipeline, not asserted at ingest.
    verification: 'unverified',
    metadata: options.metadata ?? {},
  };
}
