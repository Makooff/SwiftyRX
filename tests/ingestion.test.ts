import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import {
  extractExplicitTickers,
  normalizeDocument,
  stripHtml,
  toIsoOrNull,
} from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import type { NormalizedDocument } from '../src/domain/types.js';

const clock = FixedClock.at('2026-08-16T12:00:00Z');

beforeEach(() => {
  sourceRegistry.clear();
  sourceRegistry.register(
    describeSource({ id: 'ecb_press', name: 'ECB press', tier: 'official', jurisdiction: 'EU' }),
  );
  sourceRegistry.register(
    describeSource({ id: 'x:@someone', name: 'X account', tier: 'social', reliability: 0.2 }),
  );
});

describe('stripHtml', () => {
  it('removes markup, CDATA and entities', () => {
    expect(stripHtml('<![CDATA[<p>Rate cut of&nbsp;25bp</p>]]>')).toBe('Rate cut of 25bp');
  });

  it('drops script and style content entirely', () => {
    expect(stripHtml('<style>.a{}</style>Headline<script>evil()</script>')).toBe('Headline');
  });
});

describe('toIsoOrNull', () => {
  it('parses RFC-822 feed dates', () => {
    expect(toIsoOrNull('Sat, 15 Aug 2026 09:30:00 GMT')).toBe('2026-08-15T09:30:00.000Z');
  });

  it('parses epoch seconds', () => {
    expect(toIsoOrNull(1_755_000_000)).toBe(new Date(1_755_000_000_000).toISOString());
  });

  it('returns null rather than guessing at unusable input', () => {
    expect(toIsoOrNull('not a date')).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull('')).toBeNull();
  });
});

describe('extractExplicitTickers', () => {
  it('picks up cashtags and exchange-qualified mentions', () => {
    const tickers = extractExplicitTickers('$NVDA fell after (NASDAQ: AAPL) results');
    expect(tickers).toContain('NVDA');
    expect(tickers).toContain('AAPL');
  });

  it('does not invent tickers from ordinary capitalised words', () => {
    expect(extractExplicitTickers('The ECB and the FED met in EUROPE today')).toEqual([]);
  });
});

describe('normalizeDocument', () => {
  it('carries the source tier and reliability from the registry', () => {
    const doc = normalizeDocument(
      {
        sourceId: 'ecb_press',
        title: 'ECB raises rates',
        content: '<p>The Governing Council decided...</p>',
        publishedAt: 'Sat, 15 Aug 2026 09:30:00 GMT',
        retrievedAt: clock.now().toISOString(),
        raw: {},
      },
      { clock },
    );

    expect(doc.sourceTier).toBe('official');
    expect(doc.source_reliability).toBeGreaterThan(0.9);
    expect(doc.content).toBe('The Governing Council decided...');
    expect(doc.published_at).toBe('2026-08-15T09:30:00.000Z');
  });

  it('marks every document unverified at ingest, including official ones', () => {
    const doc = normalizeDocument(
      { sourceId: 'ecb_press', title: 'Decision', retrievedAt: clock.now().toISOString(), raw: {} },
      { clock },
    );
    expect(doc.verification).toBe('unverified');
  });

  it('gives an unknown source the lowest reliability prior', () => {
    const doc = normalizeDocument(
      { sourceId: 'some_blog', title: 'Rumour', retrievedAt: clock.now().toISOString(), raw: {} },
      { clock },
    );
    expect(doc.sourceTier).toBe('unknown');
    expect(doc.source_reliability).toBeLessThan(0.2);
  });

  it('produces a stable id for the same external document', () => {
    const build = () =>
      normalizeDocument(
        {
          sourceId: 'ecb_press',
          externalId: 'urn:ecb:pr:2026-08-15',
          title: 'Decision',
          retrievedAt: clock.now().toISOString(),
          raw: {},
        },
        { clock },
      );
    expect(build().id).toBe(build().id);
  });
});

function docFrom(overrides: Partial<NormalizedDocument> & { title: string; content: string }): NormalizedDocument {
  return normalizeDocument(
    {
      sourceId: overrides.source ?? 'ecb_press',
      ...(overrides.url ? { url: overrides.url } : {}),
      title: overrides.title,
      content: overrides.content,
      retrievedAt: clock.now().toISOString(),
      raw: {},
    },
    { clock },
  );
}

describe('Deduplicator', () => {
  it('drops an exact repeat of the same document', () => {
    const dedup = new Deduplicator({ clock });
    const doc = docFrom({ title: 'ECB holds rates', content: 'The Governing Council left rates unchanged today.' });

    expect(dedup.inspect(doc).status).toBe('new');
    expect(dedup.inspect(doc).status).toBe('exact_duplicate');
  });

  it('links, but does not drop, the same story from a second outlet', () => {
    const dedup = new Deduplicator({ clock });
    const first = docFrom({
      source: 'ecb_press',
      title: 'ECB leaves interest rates unchanged at August meeting',
      content:
        'The Governing Council of the European Central Bank decided today to leave the three key ECB interest rates unchanged after reviewing inflation data.',
    });
    const second = docFrom({
      source: 'ecb_press',
      title: 'ECB leaves interest rates unchanged at the August meeting',
      content:
        'The Governing Council of the European Central Bank decided today to leave the three key ECB interest rates unchanged, after reviewing the inflation data.',
    });

    expect(dedup.inspect(first).status).toBe('new');
    const result = dedup.inspect(second);
    // Corroboration across outlets is evidence; collapsing it would destroy
    // exactly the signal the verification stage needs.
    expect(result.status).toBe('near_duplicate');
    expect(result.document.duplicateOf).toBe(first.id);
    expect(result.similarity).toBeGreaterThan(0.7);
  });

  it('keeps unrelated stories separate', () => {
    const dedup = new Deduplicator({ clock });
    dedup.inspect(docFrom({ title: 'ECB holds rates', content: 'Monetary policy decision on interest rates.' }));
    const other = dedup.inspect(
      docFrom({ title: 'Chip maker beats estimates', content: 'Quarterly revenue exceeded analyst forecasts.' }),
    );
    expect(other.status).toBe('new');
  });

  it('forgets documents older than the comparison window', () => {
    const localClock = FixedClock.at('2026-08-16T12:00:00Z');
    const dedup = new Deduplicator({ clock: localClock, windowSeconds: 3600 });
    const doc = normalizeDocument(
      { sourceId: 'ecb_press', title: 'Rates held', content: 'Unchanged.', retrievedAt: localClock.now().toISOString(), raw: {} },
      { clock: localClock },
    );

    expect(dedup.inspect(doc).status).toBe('new');
    localClock.advance(3_600_001);
    expect(dedup.inspect(doc).status).toBe('new');
  });

  it('processes a batch, dropping exact duplicates only', () => {
    const dedup = new Deduplicator({ clock });
    const doc = docFrom({ title: 'Fed statement', content: 'The Committee decided to maintain the target range.' });
    const { kept, results } = dedup.process([doc, doc]);
    expect(kept).toHaveLength(1);
    expect(results.map((r) => r.status)).toEqual(['new', 'exact_duplicate']);
  });
});
