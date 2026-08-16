import type { EntityType } from '../../domain/types.js';

/**
 * Entity registry.
 *
 * A curated, explicit list — not an attempt at open-world named-entity
 * recognition. Precision matters far more than recall here: a false "this is
 * about NVDA" propagates into a signal about NVDA, while a miss merely leaves
 * an event unattributed and harmless.
 *
 * Extend it by adding entries. Aliases must be distinctive enough to survive
 * being matched against ordinary financial prose.
 */

export interface EntityDefinition {
  /** Canonical id: ticker for companies, ISO code for countries. */
  id: string;
  type: EntityType;
  name: string;
  /** Alternative surface forms. Matched case-insensitively on word boundaries. */
  aliases: string[];
  sector?: string;
  country?: string;
  /** Tickers whose price this entity's news plausibly moves. */
  tickers?: string[];
}

export const COMPANIES: EntityDefinition[] = [
  { id: 'AAPL', type: 'company', name: 'Apple Inc.', aliases: ['Apple'], sector: 'technology', country: 'US', tickers: ['AAPL'] },
  { id: 'MSFT', type: 'company', name: 'Microsoft Corporation', aliases: ['Microsoft'], sector: 'technology', country: 'US', tickers: ['MSFT'] },
  { id: 'NVDA', type: 'company', name: 'NVIDIA Corporation', aliases: ['NVIDIA', 'Nvidia'], sector: 'semiconductors', country: 'US', tickers: ['NVDA'] },
  { id: 'GOOGL', type: 'company', name: 'Alphabet Inc.', aliases: ['Alphabet', 'Google'], sector: 'technology', country: 'US', tickers: ['GOOGL', 'GOOG'] },
  { id: 'AMZN', type: 'company', name: 'Amazon.com Inc.', aliases: ['Amazon'], sector: 'consumer_discretionary', country: 'US', tickers: ['AMZN'] },
  { id: 'META', type: 'company', name: 'Meta Platforms Inc.', aliases: ['Meta Platforms', 'Facebook'], sector: 'technology', country: 'US', tickers: ['META'] },
  { id: 'TSLA', type: 'company', name: 'Tesla Inc.', aliases: ['Tesla'], sector: 'automotive', country: 'US', tickers: ['TSLA'] },
  { id: 'AMD', type: 'company', name: 'Advanced Micro Devices', aliases: ['AMD'], sector: 'semiconductors', country: 'US', tickers: ['AMD'] },
  { id: 'INTC', type: 'company', name: 'Intel Corporation', aliases: ['Intel'], sector: 'semiconductors', country: 'US', tickers: ['INTC'] },
  { id: 'TSM', type: 'company', name: 'Taiwan Semiconductor Manufacturing', aliases: ['TSMC'], sector: 'semiconductors', country: 'TW', tickers: ['TSM'] },
  { id: 'ASML', type: 'company', name: 'ASML Holding', aliases: ['ASML'], sector: 'semiconductors', country: 'NL', tickers: ['ASML'] },
  { id: 'JPM', type: 'company', name: 'JPMorgan Chase', aliases: ['JPMorgan', 'JP Morgan'], sector: 'financials', country: 'US', tickers: ['JPM'] },
];

export const COUNTRIES: EntityDefinition[] = [
  { id: 'US', type: 'country', name: 'United States', aliases: ['U.S.', 'USA', 'America', 'Washington'] },
  { id: 'CN', type: 'country', name: 'China', aliases: ['Beijing', "People's Republic of China"] },
  { id: 'BE', type: 'country', name: 'Belgium', aliases: ['Brussels'] },
  { id: 'DE', type: 'country', name: 'Germany', aliases: ['Berlin'] },
  { id: 'FR', type: 'country', name: 'France', aliases: ['Paris'] },
  { id: 'JP', type: 'country', name: 'Japan', aliases: ['Tokyo'] },
  { id: 'TW', type: 'country', name: 'Taiwan', aliases: ['Taipei'] },
  { id: 'GB', type: 'country', name: 'United Kingdom', aliases: ['UK', 'Britain', 'London'] },
  { id: 'EU', type: 'country', name: 'European Union', aliases: ['EU', 'euro area', 'eurozone'] },
];

/** Institutions whose statements move markets directly. */
export const INSTITUTIONS: EntityDefinition[] = [
  {
    id: 'ECB',
    type: 'other',
    name: 'European Central Bank',
    aliases: ['ECB', 'Governing Council'],
    country: 'EU',
  },
  {
    id: 'FED',
    type: 'other',
    name: 'Federal Reserve',
    aliases: ['Fed', 'FOMC', 'Federal Open Market Committee'],
    country: 'US',
  },
  { id: 'SEC', type: 'other', name: 'Securities and Exchange Commission', aliases: ['SEC'], country: 'US' },
  { id: 'BOE', type: 'other', name: 'Bank of England', aliases: ['BoE'], country: 'GB' },
  { id: 'BOJ', type: 'other', name: 'Bank of Japan', aliases: ['BoJ'], country: 'JP' },
  { id: 'NBB', type: 'other', name: 'National Bank of Belgium', aliases: ['NBB'], country: 'BE' },
];

export const SECTORS: EntityDefinition[] = [
  { id: 'semiconductors', type: 'sector', name: 'Semiconductors', aliases: ['chip industry', 'chipmakers', 'semiconductor industry'] },
  { id: 'energy', type: 'sector', name: 'Energy', aliases: ['oil and gas', 'energy sector'] },
  { id: 'financials', type: 'sector', name: 'Financials', aliases: ['banking sector', 'banks'] },
];

export const ALL_ENTITIES: EntityDefinition[] = [
  ...COMPANIES,
  ...COUNTRIES,
  ...INSTITUTIONS,
  ...SECTORS,
];

const byTicker = new Map<string, EntityDefinition>();
for (const entity of COMPANIES) {
  for (const ticker of entity.tickers ?? []) byTicker.set(ticker.toUpperCase(), entity);
}

export function entityForTicker(ticker: string): EntityDefinition | undefined {
  return byTicker.get(ticker.toUpperCase());
}

export function entityById(id: string): EntityDefinition | undefined {
  return ALL_ENTITIES.find((e) => e.id === id);
}

/** Tickers plausibly affected by an entity — used to attribute events to assets. */
export function tickersForEntity(id: string): string[] {
  const entity = entityById(id);
  if (!entity) return [];
  if (entity.tickers?.length) return entity.tickers;
  // Sector and country entities do not map to tickers on their own. Inferring
  // "tariffs on China" -> a basket of tickers is an impact-analysis judgement
  // (Phase 3), not an entity-resolution fact.
  return [];
}
