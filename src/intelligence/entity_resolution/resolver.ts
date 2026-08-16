import type { Entity, NormalizedDocument } from '../../domain/types.js';
import { ALL_ENTITIES, type EntityDefinition, entityForTicker } from './registry.js';

/**
 * Entity resolution.
 *
 * Deterministic matching against the curated registry. Three match classes,
 * with confidence reflecting how much the surface form actually pins down:
 *
 *   ticker    0.97  an explicit symbol the source itself marked up
 *   name      0.90  the full registered name
 *   alias     0.75  a common short form ("Apple", "Fed")
 *
 * Alias matching is where false positives live, so aliases are matched on word
 * boundaries only, and the confidence stays low enough that downstream scoring
 * can discount it.
 */

const MATCH_CONFIDENCE = { ticker: 0.97, name: 0.9, alias: 0.75 } as const;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary matcher.
 *
 * `\b` misbehaves around terms ending in punctuation ("U.S.", "Amazon.com"),
 * so boundaries are asserted with explicit lookarounds on word characters.
 */
function buildMatcher(term: string): RegExp {
  return new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, 'i');
}

interface CompiledTerm {
  entity: EntityDefinition;
  pattern: RegExp;
  kind: 'name' | 'alias';
  term: string;
}

const compiled: CompiledTerm[] = ALL_ENTITIES.flatMap((entity) => [
  { entity, pattern: buildMatcher(entity.name), kind: 'name' as const, term: entity.name },
  ...entity.aliases.map((alias) => ({
    entity,
    pattern: buildMatcher(alias),
    kind: 'alias' as const,
    term: alias,
  })),
]);

export interface ResolveOptions {
  /** Tickers the source itself declared; treated as high-confidence facts. */
  declaredTickers?: string[];
  /** Cap on returned entities, highest confidence first. */
  limit?: number;
}

export function resolveEntities(text: string, options: ResolveOptions = {}): Entity[] {
  const found = new Map<string, Entity>();

  const record = (entity: Entity) => {
    const existing = found.get(entity.id ?? entity.text);
    if (!existing || entity.confidence > existing.confidence) {
      found.set(entity.id ?? entity.text, entity);
    }
  };

  for (const ticker of options.declaredTickers ?? []) {
    const symbol = ticker.toUpperCase();
    const known = entityForTicker(symbol);
    record({
      type: known?.type ?? 'ticker',
      text: symbol,
      id: known?.id ?? symbol,
      confidence: MATCH_CONFIDENCE.ticker,
    });
  }

  for (const candidate of compiled) {
    const match = candidate.pattern.exec(text);
    if (!match) continue;
    record({
      type: candidate.entity.type,
      text: match[0],
      id: candidate.entity.id,
      confidence: MATCH_CONFIDENCE[candidate.kind],
    });
  }

  const entities = [...found.values()].sort((a, b) => b.confidence - a.confidence);
  return options.limit ? entities.slice(0, options.limit) : entities;
}

/** Resolve a document's entities from its title, content and declared tickers. */
export function resolveDocumentEntities(doc: NormalizedDocument): Entity[] {
  return resolveEntities(`${doc.title} ${doc.content}`, {
    declaredTickers: doc.tickers,
  });
}

/**
 * Tickers an event about these entities plausibly concerns.
 *
 * Only direct company mappings. Deriving affected tickers from a country or a
 * sector is an impact judgement, not a resolution fact, and belongs to Phase 3.
 */
export function tickersFromEntities(entities: Entity[]): string[] {
  const tickers = new Set<string>();
  for (const entity of entities) {
    if (entity.type === 'ticker' && entity.text) tickers.add(entity.text.toUpperCase());
    if (!entity.id) continue;
    const known = ALL_ENTITIES.find((e) => e.id === entity.id);
    for (const ticker of known?.tickers ?? []) tickers.add(ticker.toUpperCase());
  }
  return [...tickers];
}

/** Jurisdictions implicated by a set of entities. */
export function jurisdictionsFromEntities(entities: Entity[]): string[] {
  const out = new Set<string>();
  for (const entity of entities) {
    if (!entity.id) continue;
    if (entity.type === 'country') {
      out.add(entity.id);
      continue;
    }
    const known = ALL_ENTITIES.find((e) => e.id === entity.id);
    if (known?.country) out.add(known.country);
  }
  return [...out];
}
