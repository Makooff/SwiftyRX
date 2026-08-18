import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CategoryResult, HorizonResult } from '../src/backtesting/event-study.js';
import {
  EvidenceBook,
  eventTypeForCategory,
  summariseEvidence,
  writeEvidenceFile,
  type EvidenceFile,
} from '../src/strategy/evidence.js';

/**
 * The evidence book.
 *
 * The property that matters is the asymmetry: a measured adverse drift blocks,
 * and nothing — however significant, however large — unblocks. A book that
 * could license a trade would turn one backtest into permission, which is the
 * exact failure this project is built against.
 */

function horizon(overrides: Partial<HorizonResult> = {}): HorizonResult {
  return {
    sessions: 20,
    meanAbnormalPct: 1.0,
    medianAbnormalPct: 0.9,
    meanNetOfCostsPct: 0.7,
    hitRate: 0.55,
    stdDevPct: 8,
    naiveTStat: 9,
    tStat: 3,
    clusters: 30,
    largestClusterShare: 0.1,
    sampleSize: 500,
    ...overrides,
  };
}

function category(overrides: Partial<CategoryResult> = {}): CategoryResult {
  return {
    category: '8-K item 2.02',
    sampleSize: 500,
    horizons: [horizon()],
    verdict: 'something',
    ...overrides,
  };
}

const options = {
  generatedAt: '2026-08-17T00:00:00Z',
  windowYears: 5,
  benchmark: 'SPY',
  roundTripCostPct: 0.3,
  symbols: 40,
};

describe('mapping a study category to an event type', () => {
  it('reads an 8-K item code through the detector rules', () => {
    expect(eventTypeForCategory('8-K item 2.02')).toBe('earnings');
    expect(eventTypeForCategory('8-K item 5.02')).toBe('executive_change');
  });

  it('reads a bare form type', () => {
    expect(eventTypeForCategory('10-Q')).toBe('periodic_report');
    expect(eventTypeForCategory('4')).toBe('insider_transaction');
  });

  it('returns nothing for a form the agent has no event type for', () => {
    // Form 144 has no rule, so it cannot gate anything — that must be visible
    // rather than silently mapped to something adjacent.
    expect(eventTypeForCategory('144')).toBeUndefined();
    expect(eventTypeForCategory('SC 14N')).toBeUndefined();
  });
});

describe('summarising a study', () => {
  it('marks a significant negative drift as adverse', () => {
    const book = summariseEvidence(
      [category({ horizons: [horizon({ meanAbnormalPct: -1.64, tStat: -2.4 })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('adverse');
    expect(book.categories[0]!.eventType).toBe('earnings');
  });

  it('marks a significant positive drift smaller than costs as below_costs', () => {
    // The distinction the founding question turns on: real, and still not worth
    // trading.
    const book = summariseEvidence(
      [category({ horizons: [horizon({ meanAbnormalPct: 0.29, meanNetOfCostsPct: -0.01 })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('below_costs');
  });

  it('marks a large sample with no significant horizon as inconclusive', () => {
    const book = summariseEvidence(
      [category({ horizons: [horizon({ tStat: 0.4 })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('inconclusive');
  });

  it('marks a sample carried by too few symbols as untested, not as a finding', () => {
    const book = summariseEvidence(
      [category({ horizons: [horizon({ clusters: 3, tStat: 8 })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('untested');
  });

  it('lets an adverse horizon decide a category even when another looks good', () => {
    // A drift that turns against the position inside the holding period is not
    // something to average away against a longer horizon.
    const book = summariseEvidence(
      [
        category({
          horizons: [
            horizon({ sessions: 5, meanAbnormalPct: -0.85, tStat: -2.1 }),
            horizon({ sessions: 20, meanAbnormalPct: 2.0, meanNetOfCostsPct: 1.7, tStat: 4 }),
          ],
        }),
      ],
      options,
    );
    expect(book.categories[0]!.status).toBe('adverse');
    expect(book.categories[0]!.horizon?.sessions).toBe(5);
  });

  it('records how the study was run, so a stale or narrow book is visible', () => {
    const book = summariseEvidence([category()], options);
    expect(book.windowYears).toBe(5);
    expect(book.symbols).toBe(40);
    expect(book.benchmark).toBe('SPY');
    expect(book.roundTripCostPct).toBe(0.3);
  });
});

describe('the book as the agent reads it', () => {
  function bookWith(categories: EvidenceFile['categories']): EvidenceBook {
    return EvidenceBook.fromFile({
      generatedAt: options.generatedAt,
      windowYears: 5,
      roundTripCostPct: 0.3,
      symbols: 40,
      categories,
    });
  }

  it('blocks an event type measured drifting against a long', () => {
    const book = bookWith([
      { category: '8-K item 2.02', eventType: 'earnings', status: 'adverse', sampleSize: 109, clusters: 30, note: '' },
    ]);
    expect(book.blocks('earnings')).toBeDefined();
  });

  it('blocks nothing on a supported result, however strong', () => {
    // Support is one sample of one regime, tested alongside a dozen others. It
    // is recorded; it never opens a gate.
    const book = bookWith([
      { category: '4', eventType: 'insider_transaction', status: 'supported', sampleSize: 2759, clusters: 38, note: '' },
    ]);
    expect(book.blocks('insider_transaction')).toBeUndefined();
    expect(book.forEventType('insider_transaction')?.status).toBe('supported');
  });

  it('blocks nothing on an untested or inconclusive type', () => {
    const book = bookWith([
      { category: '10-K', eventType: 'periodic_report', status: 'inconclusive', sampleSize: 80, clusters: 30, note: '' },
    ]);
    expect(book.blocks('periodic_report')).toBeUndefined();
  });

  it('resolves several forms sharing one event type to the most cautious', () => {
    // Forms 3, 4 and 5 all classify as insider_transaction, and the agent
    // cannot tell them apart at the point it decides. If one drifts against a
    // long, the type inherits it.
    const book = bookWith([
      { category: '4', eventType: 'insider_transaction', status: 'supported', sampleSize: 2759, clusters: 38, note: '' },
      { category: '3', eventType: 'insider_transaction', status: 'adverse', sampleSize: 200, clusters: 30, note: '' },
    ]);
    expect(book.blocks('insider_transaction')?.category).toBe('3');
  });

  it('has no opinion at all when no file exists', () => {
    expect(EvidenceBook.load(join(tmpdir(), 'no-such-evidence-file.json'))).toBeUndefined();
  });

  it('treats a corrupt file as no book rather than as permission', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'evidence-')), 'evidence.json');
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(EvidenceBook.load(path)).toBeUndefined();
  });

  it('round-trips through disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'evidence-')), 'nested', 'evidence.json');
    writeEvidenceFile(
      path,
      summariseEvidence(
        [category({ horizons: [horizon({ meanAbnormalPct: -1.64, tStat: -2.4 })] })],
        options,
      ),
    );
    expect(EvidenceBook.load(path)?.blocks('earnings')).toBeDefined();
  });
});
