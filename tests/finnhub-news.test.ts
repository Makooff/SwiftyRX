import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import { FinnhubAdapter } from '../src/ingestion/market_data/finnhub.js';
import { FinnhubNewsSource } from '../src/ingestion/news/finnhub-news.js';
import { sourceRegistry } from '../src/ingestion/source-registry.js';
import { createFakeFetch } from './helpers/fake-fetch.js';

/**
 * Finnhub company news as a document source.
 *
 * Every feed running before this one published macro — rate decisions, CPI,
 * minutes. Those produce market-wide events and never a company catalyst, so
 * the model correctly answers WATCH and no order is ever placed. This is the
 * input that makes a directional signal possible at all.
 *
 * The property that matters most here is not that it fetches. It is that it
 * fetches *a slice*: Finnhub's free tier allows 60 calls a minute and that
 * budget is shared with every quote the agent takes. A forty-name watchlist
 * asked all at once would queue in the token bucket and starve the prices,
 * which are the one thing a cycle cannot proceed without.
 */

const NOW = '2026-08-16T12:00:00Z';
const WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC'];

beforeEach(() => sourceRegistry.clear());

function newsItem(symbol: string) {
  return {
    id: `${symbol}-1`,
    category: 'company',
    datetime: Math.floor(Date.parse('2026-08-16T10:00:00Z') / 1000),
    headline: `${symbol} beats expectations`,
    source: 'Reuters',
    summary: `${symbol} reported results above consensus.`,
    url: `https://example.test/${symbol}`,
    related: symbol,
  };
}

function sourceWith(options: { apiKey?: string; symbols?: string[]; perCycle?: number } = {}) {
  const clock = FixedClock.at(NOW);
  const fake = createFakeFetch([
    { match: 'company-news', body: [newsItem('X')] },
  ]);
  const adapter = new FinnhubAdapter({
    ...(options.apiKey === undefined ? { apiKey: 'test-key' } : options.apiKey ? { apiKey: options.apiKey } : {}),
    clock,
    fetchImpl: fake.impl,
  });
  const source = new FinnhubNewsSource({
    adapter,
    symbols: options.symbols ?? WATCHLIST,
    ...(options.perCycle !== undefined ? { symbolsPerCycle: options.perCycle } : {}),
    clock,
  });
  return { source, fake, clock };
}

/** Which symbols a batch of calls asked about, in order. */
function symbolsAsked(urls: string[]): string[] {
  return urls
    .map((url) => new URL(url).searchParams.get('symbol'))
    .filter((s): s is string => s !== null);
}

describe('asking Finnhub for company news', () => {
  it('produces documents the pipeline can consume', async () => {
    const { source } = sourceWith({ symbols: ['AAPL'], perCycle: 1 });
    const documents = await source.fetchDocuments();

    expect(documents).toHaveLength(1);
    expect(documents[0]!.source).toBe('finnhub_company_news');
    expect(documents[0]!.tickers).toContain('AAPL');
    // The link out to the original story, which the dashboard now renders.
    expect(documents[0]!.url).toBe('https://example.test/X');
  });

  it('asks about a slice of the watchlist, not all of it', async () => {
    // 60 calls a minute, shared with quotes. Ten news calls in one pass would
    // be a sixth of the budget for one of five adapters.
    const { source, fake } = sourceWith({ perCycle: 3 });
    await source.fetchDocuments();
    expect(symbolsAsked(fake.urls())).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('resumes where the previous cycle stopped', async () => {
    const { source, fake } = sourceWith({ perCycle: 3 });
    await source.fetchDocuments();
    await source.fetchDocuments();
    expect(symbolsAsked(fake.urls()).slice(3)).toEqual(['GOOGL', 'AMZN', 'META']);
  });

  it('wraps around and covers every symbol over enough cycles', async () => {
    // A symbol that is never reached is a symbol the system is blind to, and
    // nothing downstream would report it.
    const { source, fake } = sourceWith({ perCycle: 3 });
    for (let i = 0; i < 4; i += 1) await source.fetchDocuments();
    expect(new Set(symbolsAsked(fake.urls()))).toEqual(new Set(WATCHLIST.slice(0, 10)));
  });

  it('never asks for more symbols than exist', async () => {
    const { source, fake } = sourceWith({ symbols: ['AAPL', 'MSFT'], perCycle: 8 });
    await source.fetchDocuments();
    expect(symbolsAsked(fake.urls())).toEqual(['AAPL', 'MSFT']);
  });
});

describe('when something is missing or broken', () => {
  it('stays quiet with no API key rather than throwing', async () => {
    const { source } = sourceWith({ apiKey: '' });
    expect(source.isConfigured()).toBe(false);
    await expect(source.fetchDocuments()).resolves.toEqual([]);
  });

  it('stays quiet with an empty watchlist', async () => {
    const { source } = sourceWith({ symbols: [] });
    expect(source.isConfigured()).toBe(false);
    await expect(source.fetchDocuments()).resolves.toEqual([]);
  });

  it('keeps the other symbols when one fails', async () => {
    // A rate limit or a delisted ticker is ordinary here. Returning nothing
    // would make the cycle look like a quiet news day, which is exactly the
    // ambiguity the rest of this work exists to remove.
    const clock = FixedClock.at(NOW);
    const fake = createFakeFetch([
      { match: 'symbol=MSFT', status: 429, body: { error: 'rate limit' } },
      { match: 'company-news', body: [newsItem('OK')] },
    ]);
    const source = new FinnhubNewsSource({
      adapter: new FinnhubAdapter({ apiKey: 'test-key', clock, fetchImpl: fake.impl }),
      symbols: ['AAPL', 'MSFT', 'NVDA'],
      symbolsPerCycle: 3,
      clock,
    });

    const documents = await source.fetchDocuments();
    expect(documents).toHaveLength(2);
    expect(symbolsAsked(fake.urls())).toContain('NVDA');
  });

  it('reports itself disabled rather than unavailable without a key', async () => {
    // "Unavailable" means something we expected to work is not working. A
    // source nobody configured is not a fault.
    const { source } = sourceWith({ apiKey: '' });
    const report = await source.health();
    expect(report.state).toBe('disabled');
    expect(report.detail).toMatch(/FINNHUB_API_KEY/);
  });

  it('says so when the key is set but the watchlist is empty', async () => {
    const { source } = sourceWith({ symbols: [] });
    const report = await source.health();
    expect(report.state).toBe('disabled');
    expect(report.detail).toMatch(/WATCHLIST/);
  });

  it('reports healthy once both are present', async () => {
    const report = await sourceWith({}).source.health();
    expect(report.state).toBe('healthy');
    expect(report.credentialsPresent).toBe(true);
  });

  it('never leaks the key into a health report', async () => {
    const report = await sourceWith({}).source.health();
    expect(JSON.stringify(report)).not.toContain('test-key');
  });
});
