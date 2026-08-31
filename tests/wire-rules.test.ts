import { beforeEach, describe, expect, it } from 'vitest';
import { classifyDocument, materialityOf } from '../src/intelligence/event_detector/classifier.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { EventType } from '../src/intelligence/types.js';

/**
 * Wire-service phrasing, and what it costs.
 *
 * Two properties, and the second matters more than the first.
 *
 * A rule that fires on the right headline is easy. A rule that stays quiet on
 * ordinary market prose is what keeps the token bill and the decision journal
 * from filling with nothing — so every family here is tested both ways.
 *
 * And a rule that fires with the *wrong* type is worse than one that never
 * fires: the event study keys on the category, so a statistics print filed as
 * company earnings corrupts a measurement that later decides what may trade.
 */

beforeEach(() => {
  sourceRegistry.clear();
  sourceRegistry.registerAll([
    describeSource({ id: 'wire', name: 'Wire', tier: 'news', jurisdiction: 'US' }),
  ]);
});

function classify(headline: string) {
  return classifyDocument(
    normalizeDocument(
      {
        sourceId: 'wire',
        externalId: headline,
        title: headline,
        content: headline,
        publishedAt: '2026-08-30T10:00:00Z',
        retrievedAt: '2026-08-30T10:00:00Z',
        raw: {},
      },
      {},
    ),
  );
}

const RECOGNISED: Array<[EventType, string]> = [
  ['material_agreement', 'Microsoft signs multi-year power purchase agreement with Constellation'],
  ['material_agreement', 'Anthropic signs a deal with a utility to supply electricity'],
  ['material_agreement', 'Siemens wins contract to equip the new line'],
  ['material_agreement', 'The two firms announce a strategic partnership'],
  ['earnings', 'Nvidia beats Q3 estimates as data centre revenue jumps 62%'],
  ['earnings', 'Broadcom Q4 results top consensus'],
  ['earnings', 'Apple sales rose 5% in the quarter'],
  ['m_and_a', 'Blackstone acquires majority stake in a logistics group'],
  ['m_and_a', 'Intel in talks to buy a chip design startup'],
  ['restructuring', 'Ford cuts 3,000 jobs in restructuring plan'],
  ['legal_action', 'Appeals court ruled against the agency'],
  ['product', 'TSMC breaks ground on new plant in Arizona'],
  ['macro_release', 'US retail sales rose 0.4% in July'],
  ['macro_release', 'Consumer confidence fell in August'],
];

describe('wire-service classification', () => {
  it.each(RECOGNISED)('classifies as %s: "%s"', (type, headline) => {
    expect(classify(headline).type).toBe(type);
  });

  it('files a statistics print as macro, not as company earnings', () => {
    // "retail sales rose" matches both the earnings and the macro pattern at
    // equal weight, and the earnings rule won the tie on ordering alone until
    // "sales" was guarded. The distinction is the whole point of the category.
    expect(classify('US retail sales rose 0.4% in July').type).toBe('macro_release');
    expect(classify('Apple sales rose 5% in the quarter').type).toBe('earnings');
  });

  it('stays quiet on ordinary market prose', () => {
    // Each of these is the kind of article a business wire publishes all day
    // and that carries no event. Classifying them would cost an LLM call and
    // fill the journal with decisions about nothing.
    const noise = [
      'Investors weigh what the rally means for the months ahead',
      'A profile of the analyst who called the last downturn',
      'Five charts that explain this week in markets',
      'What to watch when trading opens on Monday',
    ];
    for (const headline of noise) {
      expect(classify(headline).type).toBe('unclassified');
    }
  });

  it('prefers the acquisition reading when a headline could be either', () => {
    // "signs agreement to acquire" is both a contract and a takeover; the
    // heavier m_and_a rule should win, because that is the more consequential
    // and more specific description of what happened.
    expect(classify('Company A signs agreement to acquire Company B').type).toBe('m_and_a');
  });
});

describe('materiality against the analysis floor', () => {
  /**
   * The arithmetic that decides whether a correctly classified story is ever
   * read. Pinned as numbers rather than described, so that changing a prior in
   * EVENT_TYPE_MATERIALITY shows up here as a failing test instead of as a
   * quiet change in how much the system analyses.
   */
  const DEFAULT_FLOOR = 0.4;

  function materiality(type: EventType, confidence: number, hasTickers: boolean): number {
    return materialityOf(
      { type, confidence, matched: [] },
      { sourceReliability: 0.7, hasTickers, hasEntities: false },
    );
  }

  it('lets a confident earnings story with a ticker through', () => {
    expect(materiality('earnings', 1, true)).toBeGreaterThanOrEqual(DEFAULT_FLOOR);
  });

  it('lets a merger with a ticker through', () => {
    expect(materiality('m_and_a', 0.6, true)).toBeGreaterThanOrEqual(DEFAULT_FLOOR);
  });

  it('refuses a signed contract even when perfectly classified and tickered', () => {
    // 0.396 against a floor of 0.4 — the case this whole feed set exists to
    // catch, missing by four thousandths. This is why MIN_EVENT_MATERIALITY
    // had to become reachable from a .env, and why the prior itself is worth
    // a second look.
    const value = materiality('material_agreement', 1, true);
    expect(value).toBeLessThan(DEFAULT_FLOOR);
    expect(value).toBeCloseTo(0.396, 3);
  });

  it('lets a ticker-less story through only from the very top priors', () => {
    // Naming no company costs a flat 40% (specificity 0.6), so what survives
    // it is decided by the prior alone. Only the highest categories clear the
    // floor, and only when the classification is certain.
    expect(materiality('earnings', 1, false)).toBeGreaterThanOrEqual(DEFAULT_FLOOR);
    expect(materiality('material_agreement', 1, false)).toBeLessThan(DEFAULT_FLOOR);
    expect(materiality('restructuring', 1, false)).toBeLessThan(DEFAULT_FLOOR);
  });

  it('drops the same top-prior story once the classification is merely likely', () => {
    // The realistic case: one keyword rule fires, confidence lands near 0.5,
    // and an earnings story with no ticker falls from 0.449 to 0.337. Certainty
    // and specificity compensate for each other, and a wire headline rarely
    // has both.
    expect(materiality('earnings', 0.5, false)).toBeLessThan(DEFAULT_FLOOR);
    expect(materiality('earnings', 0.5, true)).toBeGreaterThanOrEqual(DEFAULT_FLOOR);
  });
});
