import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  parseSymbolsFile,
  resolveUniverse,
  secFetchFloorSeconds,
} from '../src/backtesting/universe.js';

/**
 * Resolving a study's universe.
 *
 * The property worth pinning is the deduplication. The study calls the SEC
 * adapter directly and never passes through the ingestion deduplicator, so a
 * repeated ticker would contribute its filings twice — into `sampleSize` and
 * `clusters`, which are the two counts the significance bars are checked
 * against. A duplicate is not noise there; it can carry a category over the bar
 * that decides whether it is tested at all.
 */

describe('parsing a symbols file', () => {
  it('reads one ticker per line', () => {
    expect(parseSymbolsFile('AAPL\nMSFT\nNVDA\n')).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('reads comma-separated tickers, and both styles mixed', () => {
    expect(parseSymbolsFile('AAPL, MSFT\nNVDA')).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('strips comments and blank lines', () => {
    const contents = ['# US large caps', 'AAPL  # the obvious one', '', '   ', 'MSFT'].join('\n');
    expect(parseSymbolsFile(contents)).toEqual(['AAPL', 'MSFT']);
  });

  it('upper-cases, so a lower-case file is not a different universe', () => {
    expect(parseSymbolsFile('aapl\nMsFt')).toEqual(['AAPL', 'MSFT']);
  });

  it('returns nothing for an empty or comment-only file', () => {
    expect(parseSymbolsFile('')).toEqual([]);
    expect(parseSymbolsFile('# nothing here\n')).toEqual([]);
  });
});

describe('resolving the universe', () => {
  it('removes duplicates and names them', () => {
    const { symbols, duplicates } = resolveUniverse(['AAPL', 'MSFT', 'AAPL', 'aapl']);
    expect(symbols).toEqual(['AAPL', 'MSFT']);
    expect(duplicates).toEqual(['AAPL']);
  });

  it('keeps the order the caller gave', () => {
    expect(resolveUniverse(['NVDA', 'AAPL', 'MSFT']).symbols).toEqual(['NVDA', 'AAPL', 'MSFT']);
  });

  it('treats differently-cased and padded spellings as one symbol', () => {
    // Otherwise "aapl" and " AAPL " are two entries in the universe and one
    // company in the data, which double-counts every filing it made.
    const { symbols, duplicates } = resolveUniverse([' aapl ', 'AAPL']);
    expect(symbols).toEqual(['AAPL']);
    expect(duplicates).toEqual(['AAPL']);
  });

  it('reports no duplicates when there are none', () => {
    expect(resolveUniverse(['AAPL', 'MSFT']).duplicates).toEqual([]);
  });
});

describe('the request floor', () => {
  it('is one SEC request per symbol at the self-imposed rate', () => {
    expect(secFetchFloorSeconds(300)).toBe(60);
    expect(secFetchFloorSeconds(0)).toBe(0);
  });

  it('formats a duration a person can act on', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(90)).toBe('1m 30s');
  });
});
