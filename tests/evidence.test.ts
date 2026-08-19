import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runEventStudy,
  type CategoryResult,
  type HorizonResult,
  type StudyEvent,
} from '../src/backtesting/event-study.js';
import type { Bar } from '../src/domain/types.js';
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
    pValue: 0.005,
    // The study sets this across the whole run; a fixture states it directly.
    survivesMultiplicity: true,
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

/** Same builders as tests/event-study.test.ts, for the end-to-end veto test. */
function studyBars(symbol: string, closes: number[], startDay = 1): Bar[] {
  return closes.map((close, i) => {
    const timestamp = new Date(Date.UTC(2026, 0, startDay + i)).toISOString();
    return {
      symbol,
      timestamp,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000_000,
      interval: '1Day' as const,
      freshness: {
        asOf: timestamp,
        retrievedAt: timestamp,
        delayClass: 'end_of_day' as const,
        feed: 'test',
      },
    };
  });
}

function studyEvent(symbol: string, day: number, category: string): StudyEvent {
  return { symbol, at: new Date(Date.UTC(2026, 0, day, 21, 0)).toISOString(), category };
}

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
      [category({ horizons: [horizon({ tStat: 0.4, survivesMultiplicity: false })] })],
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

  it('will not call a result a finding when it did not survive the run it was in', () => {
    // The distinction that turned seven "findings" into zero: crossing
    // |t|=1.96 on its own means little when a hundred tests were run.
    const book = summariseEvidence(
      [category({ horizons: [horizon({ tStat: 2.35, survivesMultiplicity: false })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('inconclusive');
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

describe('refusing and claiming are held to different bars', () => {
  it('still refuses a category that lost multiplicity survival', () => {
    // The bug this guards. A veto derived from `survivesMultiplicity` moves
    // when the family grows, so connecting a new data source could retire a
    // block on a category measured drifting against a long — the evidence
    // against it unchanged, the refusal gone.
    const book = summariseEvidence(
      [
        category({
          horizons: [horizon({ meanAbnormalPct: -1.64, tStat: -2.4, survivesMultiplicity: false })],
        }),
      ],
      options,
    );
    expect(book.categories[0]!.status).toBe('adverse');
  });

  it('will not refuse on a drift that never crossed the nominal bar', () => {
    // Loosening the veto must not mean abandoning it: a negative mean that
    // could easily be noise is still nothing.
    const book = summariseEvidence(
      [
        category({
          horizons: [horizon({ meanAbnormalPct: -1.64, tStat: -0.9, survivesMultiplicity: false })],
        }),
      ],
      options,
    );
    expect(book.categories[0]!.status).toBe('inconclusive');
  });

  it('will not refuse on a sample carried by too few symbols', () => {
    // One company's bad five years is not a category effect, in either
    // direction.
    const book = summariseEvidence(
      [category({ horizons: [horizon({ meanAbnormalPct: -4, tStat: -6, clusters: 3 })] })],
      options,
    );
    expect(book.categories[0]!.status).toBe('untested');
  });

  it('still requires multiplicity survival before claiming support', () => {
    // The strict half is unchanged: the asymmetry is the point.
    const book = summariseEvidence(
      [
        category({
          horizons: [horizon({ meanAbnormalPct: 2.0, tStat: 2.4, survivesMultiplicity: false })],
        }),
      ],
      options,
    );
    expect(book.categories[0]!.status).toBe('inconclusive');
  });

  it('keeps a real adverse category blocked when the study grows to forty-one tests', () => {
    // End to end against the real study, mirroring the multiplicity test in
    // tests/event-study.test.ts: one category with a modest negative drift,
    // unchanged, measured alone and then among forty quiet ones. Its own
    // evidence never moves, so its block must not either.
    const real = Array.from({ length: 12 }, (_, i) => `REAL${i}`);
    const quiet = Array.from({ length: 12 }, (_, i) => `QUIET${i}`);

    const barsBySymbol = new Map<string, Bar[]>();
    real.forEach((symbol, s) => {
      barsBySymbol.set(
        symbol,
        studyBars(
          symbol,
          // Negative drift, with an aperiodic wobble so the variance is not zero.
          Array.from({ length: 90 }, (_, i) =>
            Number((100 * 0.9996 ** i * (1 + 0.02 * Math.sin(i * 1.7 + s))).toFixed(4)),
          ),
        ),
      );
    });
    for (const symbol of quiet) {
      barsBySymbol.set(symbol, studyBars(symbol, Array.from({ length: 90 }, () => 100)));
    }

    const realEvents = real.flatMap((symbol) =>
      Array.from({ length: 4 }, (_, i) => studyEvent(symbol, i * 5 + 1, '8-K item 2.02')),
    );
    const quietEvents = Array.from({ length: 40 }, (_, c) =>
      quiet.flatMap((symbol) =>
        Array.from({ length: 4 }, (_, i) => studyEvent(symbol, i * 5 + 1, `quiet${c}`)),
      ),
    ).flat();

    const alone = runEventStudy({ events: realEvents, barsBySymbol, horizons: [5] });
    const amongMany = runEventStudy({
      events: [...realEvents, ...quietEvents],
      barsBySymbol,
      horizons: [5],
    });

    const findReal = (rs: typeof alone) => rs.find((r) => r.category === '8-K item 2.02')!;
    // The evidence itself is identical in both runs — only the company it keeps changed.
    expect(findReal(alone).horizons[0]!.tStat).toBe(findReal(amongMany).horizons[0]!.tStat);
    expect(findReal(alone).horizons[0]!.meanAbnormalPct).toBeLessThan(0);
    expect(findReal(alone).horizons[0]!.survivesMultiplicity).toBe(true);
    expect(findReal(amongMany).horizons[0]!.survivesMultiplicity).toBe(false);

    // ...and the refusal holds through that, which is the whole point.
    for (const results of [alone, amongMany]) {
      const bookFile = summariseEvidence(results, options);
      const entry = bookFile.categories.find((c) => c.category === '8-K item 2.02')!;
      expect(entry.status).toBe('adverse');
      expect(EvidenceBook.fromFile(bookFile).blocks('earnings')).toBeDefined();
    }
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
