import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import { DataIntegrityError, RateLimitError, StaleDataError, UpstreamError } from '../src/core/errors.js';
import { EcbAdapter, parseEcbCsv } from '../src/ingestion/macro/ecb.js';
import { FredAdapter } from '../src/ingestion/macro/fred.js';
import { AlpacaMarketDataAdapter } from '../src/ingestion/market_data/alpaca.js';
import { AlphaVantageAdapter } from '../src/ingestion/market_data/alpha-vantage.js';
import { FinnhubAdapter } from '../src/ingestion/market_data/finnhub.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import { parseFeedItems, RssAdapter } from '../src/ingestion/news/rss.js';
import { SecEdgarAdapter } from '../src/ingestion/official_sources/sec-edgar.js';
import { XAdapter } from '../src/ingestion/social/x.js';
import { sourceRegistry } from '../src/ingestion/source-registry.js';
import { createFakeFetch } from './helpers/fake-fetch.js';

const NOW = '2026-08-16T12:00:00Z';
const newClock = () => FixedClock.at(NOW);

beforeEach(() => sourceRegistry.clear());

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>ECB press</title>
    <item>
      <title>ECB holds key interest rates unchanged</title>
      <link>https://www.ecb.europa.eu/press/pr/date/2026/html/example.en.html</link>
      <description><![CDATA[<p>The Governing Council decided to keep rates unchanged.</p>]]></description>
      <pubDate>Sat, 16 Aug 2026 11:45:00 GMT</pubDate>
      <guid>urn:ecb:pr:2026-08-16</guid>
    </item>
    <item>
      <title>Old announcement</title>
      <link>https://www.ecb.europa.eu/press/pr/date/2020/html/old.en.html</link>
      <description>Historic release.</description>
      <pubDate>Mon, 03 Feb 2020 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Fed issues statement</title>
    <link href="https://www.federalreserve.gov/newsevents/pressreleases/example.htm"/>
    <summary>The Committee decided to maintain the target range.</summary>
    <updated>2026-08-16T11:00:00Z</updated>
    <id>tag:federalreserve.gov,2026:example</id>
  </entry>
</feed>`;

function rssAdapter(xml: string, feedId = 'ecb_press') {
  const clock = newClock();
  const fake = createFakeFetch([{ match: 'example.test', text: xml }]);
  const adapter = new RssAdapter('official_rss', {
    feeds: [
      {
        id: feedId,
        name: 'Test feed',
        url: 'https://example.test/feed.xml',
        tier: 'official',
        category: 'official',
        jurisdiction: 'EU',
      },
    ],
    userAgent: 'ai-market-agent ops@example.com',
    clock,
    fetchImpl: fake.impl,
  });
  return { adapter, fake, clock };
}

describe('RssAdapter', () => {
  it('parses RSS 2.0 items', () => {
    expect(parseFeedItems(RSS_XML)).toHaveLength(2);
  });

  it('parses Atom entries', () => {
    expect(parseFeedItems(ATOM_XML)).toHaveLength(1);
  });

  it('returns an empty list for unparseable content instead of throwing', () => {
    expect(parseFeedItems('<html><body>not a feed</body></html>')).toEqual([]);
  });

  it('normalises feed items into documents', async () => {
    const { adapter } = rssAdapter(RSS_XML);
    const docs = await adapter.fetchDocuments();

    expect(docs).toHaveLength(2);
    const first = docs[0]!;
    expect(first.title).toBe('ECB holds key interest rates unchanged');
    expect(first.content).toBe('The Governing Council decided to keep rates unchanged.');
    expect(first.published_at).toBe('2026-08-16T11:45:00.000Z');
    expect(first.sourceTier).toBe('official');
    expect(first.verification).toBe('unverified');
  });

  it('honours the since window', async () => {
    const { adapter } = rssAdapter(RSS_XML);
    const docs = await adapter.fetchDocuments({ since: new Date('2026-01-01T00:00:00Z') });
    expect(docs).toHaveLength(1);
  });

  it('sends the configured User-Agent', async () => {
    const { adapter, fake } = rssAdapter(RSS_XML);
    await adapter.fetchDocuments();
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('ai-market-agent ops@example.com');
  });

  it('reports unavailable rather than throwing when the feed is down', async () => {
    const clock = newClock();
    const fake = createFakeFetch([{ match: 'example.test', status: 500 }]);
    const adapter = new RssAdapter('official_rss', {
      feeds: [
        {
          id: 'broken',
          name: 'Broken',
          url: 'https://example.test/feed.xml',
          tier: 'official',
          category: 'official',
          jurisdiction: 'EU',
        },
      ],
      userAgent: 'ai-market-agent ops@example.com',
      clock,
      fetchImpl: fake.impl,
    });

    const report = await adapter.health();
    expect(report.state).toBe('unavailable');
  });

  it('keeps going when one feed of several fails', async () => {
    const clock = newClock();
    const fake = createFakeFetch([
      { match: 'good.test', text: RSS_XML },
      { match: 'bad.test', networkError: true },
    ]);
    const adapter = new RssAdapter('official_rss', {
      feeds: [
        { id: 'good', name: 'Good', url: 'https://good.test/f.xml', tier: 'official', category: 'official', jurisdiction: 'EU' },
        { id: 'bad', name: 'Bad', url: 'https://bad.test/f.xml', tier: 'official', category: 'official', jurisdiction: 'EU' },
      ],
      userAgent: 'ai-market-agent ops@example.com',
      clock,
      fetchImpl: fake.impl,
    });

    const docs = await adapter.fetchDocuments();
    expect(docs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SEC EDGAR
// ---------------------------------------------------------------------------

const COMPANY_TICKERS = {
  '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  '1': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
};

const SUBMISSIONS = {
  cik: '0000320193',
  name: 'Apple Inc.',
  tickers: ['AAPL'],
  filings: {
    recent: {
      accessionNumber: ['0000320193-26-000075', '0000320193-26-000070'],
      filingDate: ['2026-08-15', '2026-05-02'],
      acceptanceDateTime: ['2026-08-15T16:31:00.000Z', '2026-05-02T16:30:00.000Z'],
      form: ['8-K', '10-Q'],
      primaryDocument: ['aapl-20260815.htm', 'aapl-20260502.htm'],
      primaryDocDescription: ['8-K', '10-Q'],
      reportDate: ['2026-08-15', '2026-03-28'],
      items: ['2.02,9.01', ''],
    },
  },
};

function secAdapter(contactEmail: string | null = 'ops@example.com') {
  const clock = newClock();
  const fake = createFakeFetch([
    { match: 'company_tickers.json', body: COMPANY_TICKERS },
    { match: '/submissions/CIK0000320193.json', body: SUBMISSIONS },
  ]);
  const adapter = new SecEdgarAdapter({
    userAgent: `ai-market-agent ${contactEmail ?? ''}`.trim(),
    ...(contactEmail ? { contactEmail } : {}),
    tickers: ['AAPL'],
    clock,
    fetchImpl: fake.impl,
  });
  return { adapter, fake, clock };
}

describe('SecEdgarAdapter', () => {
  it('refuses to run without a contact address, as SEC policy requires', async () => {
    const { adapter } = secAdapter(null);
    expect(adapter.isConfigured()).toBe(false);
    expect(await adapter.fetchDocuments()).toEqual([]);
    expect((await adapter.health()).state).toBe('disabled');
  });

  it('maps tickers to CIKs and fetches filings', async () => {
    const { adapter } = secAdapter();
    const docs = await adapter.fetchDocuments();

    expect(docs).toHaveLength(2);
    const eightK = docs[0]!;
    expect(eightK.tickers).toContain('AAPL');
    expect(eightK.sourceTier).toBe('regulatory_filing');
    expect(eightK.metadata.form).toBe('8-K');
    expect(eightK.metadata.marketMoving).toBe(true);
    expect(eightK.url).toContain('/Archives/edgar/data/320193/000032019326000075/');
  });

  it('uses the acceptance timestamp as the publication time', async () => {
    const { adapter } = secAdapter();
    const docs = await adapter.fetchDocuments();
    expect(docs[0]!.published_at).toBe('2026-08-15T16:31:00.000Z');
  });

  it('filters by the since window', async () => {
    const { adapter } = secAdapter();
    const docs = await adapter.fetchDocuments({ since: new Date('2026-06-01T00:00:00Z') });
    expect(docs).toHaveLength(1);
  });

  it('caches the CIK map instead of refetching it', async () => {
    const { adapter, fake } = secAdapter();
    await adapter.fetchDocuments();
    await adapter.fetchDocuments();
    expect(fake.urls().filter((u) => u.includes('company_tickers.json'))).toHaveLength(1);
  });

  it('skips tickers with no SEC registration rather than failing the batch', async () => {
    const { adapter } = secAdapter();
    adapter.setTickers(['AAPL', 'ASML.AS']);
    const docs = await adapter.fetchDocuments();
    expect(docs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// FRED
// ---------------------------------------------------------------------------

describe('FredAdapter', () => {
  it('is disabled without an API key', async () => {
    const adapter = new FredAdapter({ clock: newClock() });
    expect(adapter.isConfigured()).toBe(false);
    expect((await adapter.health()).state).toBe('disabled');
  });

  it('parses observations and preserves missing values as null', async () => {
    const fake = createFakeFetch([
      {
        match: 'series/observations',
        body: {
          observations: [
            { date: '2026-08-15', value: '4.33', realtime_start: '2026-08-16' },
            { date: '2026-08-14', value: '.', realtime_start: '2026-08-15' },
          ],
        },
      },
    ]);
    const adapter = new FredAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    const observations = await adapter.getSeries('DFF');

    expect(observations).toHaveLength(2);
    expect(observations[0]!.value).toBe(4.33);
    // "." means "not published"; turning it into 0 would be a fabricated data point.
    expect(observations[1]!.value).toBeNull();
  });

  it('requests a specific vintage for point-in-time queries', async () => {
    const fake = createFakeFetch([{ match: 'series/observations', body: { observations: [] } }]);
    const adapter = new FredAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    await adapter.getSeriesAsOf('CPIAUCSL', new Date('2024-03-15T00:00:00Z'));

    const url = fake.urls()[0]!;
    expect(url).toContain('realtime_start=2024-03-15');
    expect(url).toContain('realtime_end=2024-03-15');
    expect(url).toContain('observation_end=2024-03-15');
  });

  it('keeps the API key out of logged URLs', async () => {
    const fake = createFakeFetch([{ match: 'series/observations', body: { observations: [] } }]);
    const adapter = new FredAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    await adapter.getSeries('DFF');
    // The key is sent upstream (it must be) but never appears in error context.
    expect(fake.urls()[0]).toContain('api_key=test-key-123456');
    expect(adapter.getStats().lastErrorMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ECB
// ---------------------------------------------------------------------------

const ECB_CSV = `KEY,FREQ,CURRENCY,TIME_PERIOD,OBS_VALUE,TITLE
EXR.D.USD.EUR.SP00.A,D,USD,2026-08-14,1.0921,US dollar/Euro
EXR.D.USD.EUR.SP00.A,D,USD,2026-08-15,1.0935,US dollar/Euro`;

describe('EcbAdapter', () => {
  it('parses the csvdata response', () => {
    const rows = parseEcbCsv(ECB_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.OBS_VALUE).toBe('1.0921');
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseEcbCsv('A,B\n"one, two",three');
    expect(rows[0]!.A).toBe('one, two');
    expect(rows[0]!.B).toBe('three');
  });

  it('returns observations newest first', async () => {
    const fake = createFakeFetch([{ match: 'data-api.ecb.europa.eu', text: ECB_CSV }]);
    const adapter = new EcbAdapter({ clock: newClock(), fetchImpl: fake.impl });
    const observations = await adapter.getSeries('EXR/D.USD.EUR.SP00.A');

    expect(observations[0]!.date).toBe('2026-08-15');
    expect(observations[0]!.value).toBe(1.0935);
  });

  it('needs no credentials', () => {
    expect(new EcbAdapter({ clock: newClock() }).isConfigured()).toBe(true);
  });

  it('rejects a malformed series id', async () => {
    const adapter = new EcbAdapter({ clock: newClock(), fetchImpl: createFakeFetch([]).impl });
    await expect(adapter.getSeries('NOSLASH')).rejects.toThrow(/flowRef/);
  });
});

// ---------------------------------------------------------------------------
// Market data providers
// ---------------------------------------------------------------------------

describe('AlpacaMarketDataAdapter', () => {
  const quoteBody = {
    symbol: 'AAPL',
    quote: { t: '2026-08-16T11:59:50Z', ap: 231.5, as: 100, bp: 231.4, bs: 200 },
  };

  it('is disabled without credentials', async () => {
    const adapter = new AlpacaMarketDataAdapter({ clock: newClock() });
    expect(adapter.isConfigured()).toBe(false);
    expect((await adapter.health()).state).toBe('disabled');
  });

  it('maps a quote and derives the mid price', async () => {
    const fake = createFakeFetch([{ match: '/quotes/latest', body: quoteBody }]);
    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    const quote = await adapter.getQuote('AAPL');
    expect(quote.bid).toBe(231.4);
    expect(quote.ask).toBe(231.5);
    expect(quote.last).toBeCloseTo(231.45, 4);
    expect(quote.freshness.feed).toBe('alpaca:iex');
  });

  it('follows pagination instead of silently truncating the range', async () => {
    // Found against the live API: a five-year request returned exactly 1000
    // bars and looked complete. Alpaca pages its bar responses, and ignoring
    // `next_page_token` quietly shortened every backtest built on it.
    const bar = (day: number) => ({
      t: `2021-0${(day % 9) + 1}-01T04:00:00Z`,
      o: 100,
      h: 101,
      l: 99,
      c: 100.5,
      v: 1_000_000,
    });

    const fake = createFakeFetch([
      // Most specific first: `routes.find` takes the first match, and both
      // routes contain "/bars".
      {
        match: 'page_token=PAGE2',
        body: { symbol: 'AAPL', bars: Array.from({ length: 258 }, (_, i) => bar(i)), next_page_token: null },
      },
      {
        match: '/bars',
        body: {
          symbol: 'AAPL',
          bars: Array.from({ length: 1000 }, (_, i) => bar(i)),
          next_page_token: 'PAGE2',
        },
      },
    ]);

    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    const bars = await adapter.getBars('AAPL', '1Day', { start: new Date('2021-08-16T00:00:00Z') });

    expect(bars).toHaveLength(1258);
    expect(fake.urls()).toHaveLength(2);
    expect(fake.urls()[1]).toContain('page_token=PAGE2');
  });

  it('stops paginating once the caller has the bars it asked for', async () => {
    const fake = createFakeFetch([
      {
        match: '/bars',
        body: {
          symbol: 'AAPL',
          bars: Array.from({ length: 10 }, () => ({
            t: '2021-01-01T04:00:00Z',
            o: 1,
            h: 1,
            l: 1,
            c: 1,
            v: 1,
          })),
          next_page_token: 'MORE',
        },
      },
    ]);

    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    // A token is offered, but the caller wanted 10. Chasing it anyway would
    // bill requests for data nobody asked for.
    const bars = await adapter.getBars('AAPL', '1Day', {
      start: new Date('2021-01-01T00:00:00Z'),
      limit: 10,
    });

    expect(bars).toHaveLength(10);
    expect(fake.urls()).toHaveLength(1);
  });

  it('does not label the free IEX feed as consolidated real-time data', async () => {
    const fake = createFakeFetch([{ match: '/quotes/latest', body: quoteBody }]);
    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      feed: 'iex',
      clock: newClock(),
      fetchImpl: fake.impl,
    });
    const quote = await adapter.getQuote('AAPL');
    expect(quote.freshness.delayClass).not.toBe('realtime');
  });

  it('sends credentials as headers, never in the URL', async () => {
    const fake = createFakeFetch([{ match: '/quotes/latest', body: quoteBody }]);
    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });
    await adapter.getQuote('AAPL');
    expect(fake.urls()[0]).not.toContain('secret-value-123456');
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['APCA-API-SECRET-KEY']).toBe('secret-value-123456');
  });

  it('rejects an empty quote payload rather than inventing a price', async () => {
    const fake = createFakeFetch([{ match: '/quotes/latest', body: { symbol: 'AAPL' } }]);
    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });
    await expect(adapter.getQuote('AAPL')).rejects.toThrow(DataIntegrityError);
  });

  it('maps bars', async () => {
    const fake = createFakeFetch([
      {
        match: '/bars',
        body: {
          symbol: 'AAPL',
          bars: [
            { t: '2026-08-15T00:00:00Z', o: 230, h: 233, l: 229.5, c: 232.1, v: 51_000_000, n: 400_000, vw: 231.7 },
          ],
        },
      },
    ]);
    const adapter = new AlpacaMarketDataAdapter({
      apiKeyId: 'key-id-123456',
      apiSecretKey: 'secret-value-123456',
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    const bars = await adapter.getBars('AAPL', '1Day', { start: new Date('2026-08-01T00:00:00Z') });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(232.1);
    expect(bars[0]!.vwap).toBe(231.7);
  });
});

describe('FinnhubAdapter', () => {
  it('rejects the all-zero body Finnhub returns for unknown symbols', async () => {
    const fake = createFakeFetch([
      { match: '/quote', body: { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 } },
    ]);
    const adapter = new FinnhubAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    await expect(adapter.getQuote('NOTREAL')).rejects.toThrow(DataIntegrityError);
  });

  it('maps a valid quote', async () => {
    const fake = createFakeFetch([
      { match: '/quote', body: { c: 231.42, h: 233, l: 229, o: 230, pc: 229.8, t: 1_755_345_590 } },
    ]);
    const adapter = new FinnhubAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    const quote = await adapter.getQuote('AAPL');
    expect(quote.last).toBe(231.42);
  });

  it('fails loudly on candles without a paid entitlement, instead of returning nothing', async () => {
    const adapter = new FinnhubAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: createFakeFetch([]).impl });
    await expect(
      adapter.getBars('AAPL', '1Day', { start: new Date('2026-01-01T00:00:00Z') }),
    ).rejects.toThrow(UpstreamError);
  });

  it('maps company news into low-tier documents', async () => {
    const fake = createFakeFetch([
      {
        match: '/company-news',
        body: [
          {
            id: 7_777_777,
            category: 'company',
            datetime: 1_755_340_000,
            headline: 'Apple announces new product line',
            source: 'SomeOutlet',
            summary: 'The company revealed details today.',
            url: 'https://example.com/story',
            related: 'AAPL',
          },
        ],
      },
    ]);
    const adapter = new FinnhubAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    const docs = await adapter.fetchCompanyNews('AAPL');

    expect(docs).toHaveLength(1);
    expect(docs[0]!.tickers).toContain('AAPL');
    expect(docs[0]!.sourceTier).toBe('aggregator');
    expect(docs[0]!.metadata.originalPublisher).toBe('SomeOutlet');
  });
});

describe('AlphaVantageAdapter', () => {
  const dailyBody = {
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily)': {
      '2026-08-14': { '1. open': '229.0', '2. high': '231.0', '3. low': '228.0', '4. close': '230.5', '5. volume': '40000000' },
      '2026-08-15': { '1. open': '230.5', '2. high': '233.0', '3. low': '230.0', '4. close': '232.1', '5. volume': '45000000' },
    },
  };

  it('detects the HTTP-200 rate limit body', async () => {
    const fake = createFakeFetch([
      { match: 'alphavantage', body: { Information: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' } },
    ]);
    const adapter = new AlphaVantageAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    await expect(adapter.getBars('AAPL', '1Day', { start: new Date('2026-08-01T00:00:00Z') })).rejects.toThrow(
      RateLimitError,
    );
  });

  it('enforces the daily request budget locally', async () => {
    const fake = createFakeFetch([{ match: 'alphavantage', body: dailyBody }]);
    const adapter = new AlphaVantageAdapter({
      apiKey: 'test-key-123456',
      requestsPerDay: 1,
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    await adapter.getBars('AAPL', '1Day', { start: new Date('2026-08-01T00:00:00Z') });
    expect(adapter.remainingDailyRequests).toBe(0);
    await expect(adapter.getBars('MSFT', '1Day', { start: new Date('2026-08-01T00:00:00Z') })).rejects.toThrow(
      RateLimitError,
    );
  });

  it('returns bars sorted oldest to newest', async () => {
    const fake = createFakeFetch([{ match: 'alphavantage', body: dailyBody }]);
    const adapter = new AlphaVantageAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    const bars = await adapter.getBars('AAPL', '1Day', { start: new Date('2026-08-01T00:00:00Z') });

    expect(bars).toHaveLength(2);
    expect(bars[0]!.timestamp < bars[1]!.timestamp).toBe(true);
    expect(bars[1]!.close).toBe(232.1);
  });

  it('marks daily data as end-of-day, not real-time', async () => {
    const fake = createFakeFetch([{ match: 'alphavantage', body: dailyBody }]);
    const adapter = new AlphaVantageAdapter({ apiKey: 'test-key-123456', clock: newClock(), fetchImpl: fake.impl });
    const quote = await adapter.getQuote('AAPL');
    expect(quote.freshness.delayClass).toBe('end_of_day');
  });
});

// ---------------------------------------------------------------------------
// Market data service — staleness and failover
// ---------------------------------------------------------------------------

describe('MarketDataService', () => {
  it('refuses a quote that exceeds the staleness limit', async () => {
    const clock = newClock();
    const fake = createFakeFetch([
      {
        match: '/quotes/latest',
        // Two hours old.
        body: { symbol: 'AAPL', quote: { t: '2026-08-16T10:00:00Z', ap: 231.5, bp: 231.4 } },
      },
    ]);
    const service = new MarketDataService({
      providers: [
        new AlpacaMarketDataAdapter({
          apiKeyId: 'key-id-123456',
          apiSecretKey: 'secret-value-123456',
          clock,
          fetchImpl: fake.impl,
        }),
      ],
      maxStalenessSeconds: 120,
      clock,
    });

    // Trading on a two-hour-old price is trading on a market that no longer
    // exists. The correct answer is to refuse.
    await expect(service.getQuote('AAPL')).rejects.toThrow(StaleDataError);
  });

  it('falls back to the next provider when the first fails', async () => {
    const clock = newClock();
    const fake = createFakeFetch([
      { match: 'data.alpaca.markets', networkError: true },
      { match: 'finnhub.io', body: { c: 231.42, t: Math.floor(new Date(NOW).getTime() / 1000) - 10 } },
    ]);

    const service = new MarketDataService({
      providers: [
        new AlpacaMarketDataAdapter({
          apiKeyId: 'key-id-123456',
          apiSecretKey: 'secret-value-123456',
          clock,
          fetchImpl: fake.impl,
        }),
        new FinnhubAdapter({ apiKey: 'test-key-123456', clock, fetchImpl: fake.impl }),
      ],
      maxStalenessSeconds: 120,
      clock,
    });

    const result = await service.getQuote('AAPL');
    expect(result.provider).toBe('finnhub');
    expect(result.fallbacksUsed).toContain('alpaca_data');
  });

  it('excludes unconfigured providers entirely', () => {
    const clock = newClock();
    const service = new MarketDataService({
      providers: [
        new AlpacaMarketDataAdapter({ clock }),
        new FixtureMarketDataAdapter({ clock }),
      ],
      maxStalenessSeconds: 120,
      clock,
    });
    expect(service.configuredProviders).toEqual(['fixture_market_data']);
  });

  it('reports DO NOT TRADE when no provider can supply a quote', async () => {
    const clock = newClock();
    const service = new MarketDataService({ providers: [], maxStalenessSeconds: 120, clock });
    await expect(service.getQuote('AAPL')).rejects.toThrow(/DO NOT TRADE/);
  });
});

describe('FixtureMarketDataAdapter', () => {
  it('is deterministic for a given symbol and window', async () => {
    const adapter = new FixtureMarketDataAdapter({ clock: newClock() });
    const options = { start: new Date('2026-08-10T00:00:00Z'), end: new Date('2026-08-16T00:00:00Z') };
    const first = await adapter.getBars('AAPL', '1Day', options);
    const second = await adapter.getBars('AAPL', '1Day', options);
    expect(first).toEqual(second);
  });

  it('labels itself as synthetic so results cannot be mistaken for market data', async () => {
    const adapter = new FixtureMarketDataAdapter({ clock: newClock() });
    const quote = await adapter.getQuote('AAPL');
    expect(quote.freshness.feed).toContain('fixture');
    expect(adapter.delayNote).toContain('SYNTHETIC');
  });
});

// ---------------------------------------------------------------------------
// X / social
// ---------------------------------------------------------------------------

describe('XAdapter', () => {
  const baseOptions = {
    bearerToken: 'bearer-token-123456',
    watchedAccounts: ['@examplegov'],
    maxPostsReadPerDay: 50,
    enabled: true,
  };

  it('is disabled by default', async () => {
    const adapter = new XAdapter({ ...baseOptions, enabled: false, clock: newClock() });
    expect(adapter.isConfigured()).toBe(false);
    expect(await adapter.fetchDocuments()).toEqual([]);
    expect((await adapter.health()).state).toBe('disabled');
  });

  it('stays disabled with a zero read budget, because reads are billed', () => {
    const adapter = new XAdapter({ ...baseOptions, maxPostsReadPerDay: 0, clock: newClock() });
    expect(adapter.isConfigured()).toBe(false);
  });

  it('stays disabled without an explicit account list', () => {
    const adapter = new XAdapter({ ...baseOptions, watchedAccounts: [], clock: newClock() });
    expect(adapter.isConfigured()).toBe(false);
  });

  it('marks every post as unverified and unable to trigger an order', async () => {
    const fake = createFakeFetch([
      { match: '/users/by/username/', body: { data: { id: '99', name: 'Example', username: 'examplegov' } } },
      {
        match: '/users/99/tweets',
        body: {
          data: [
            {
              id: '1234567890',
              text: 'Announcing a new tariff on imported semiconductors, effective immediately. $NVDA',
              created_at: '2026-08-16T11:55:00.000Z',
              entities: { cashtags: [{ tag: 'NVDA' }] },
            },
          ],
        },
      },
    ]);

    const adapter = new XAdapter({ ...baseOptions, clock: newClock(), fetchImpl: fake.impl });
    const docs = await adapter.fetchDocuments();

    expect(docs).toHaveLength(1);
    const post = docs[0]!;
    expect(post.sourceTier).toBe('social');
    expect(post.source_reliability).toBeLessThanOrEqual(0.25);
    expect(post.verification).toBe('unverified');
    // A post is a lead, never a trade trigger — however dramatic it sounds.
    expect(post.metadata.canTriggerOrderDirectly).toBe(false);
    expect(post.metadata.requiresCorroboration).toBe(true);
    expect(post.tickers).toContain('NVDA');
  });

  it('charges reads against the daily budget', async () => {
    const fake = createFakeFetch([
      { match: '/users/by/username/', body: { data: { id: '99', name: 'Example', username: 'examplegov' } } },
      {
        match: '/users/99/tweets',
        body: { data: [{ id: '1', text: 'one' }, { id: '2', text: 'two' }, { id: '3', text: 'three' }] },
      },
    ]);
    const adapter = new XAdapter({ ...baseOptions, clock: newClock(), fetchImpl: fake.impl });

    await adapter.fetchDocuments();
    expect(adapter.remainingReadBudget).toBe(47);
  });

  it('stops fetching once the budget is exhausted', async () => {
    const fake = createFakeFetch([
      { match: '/users/by/username/', body: { data: { id: '99', name: 'Example', username: 'examplegov' } } },
      { match: '/users/99/tweets', body: { data: [{ id: '1', text: 'one' }] } },
    ]);
    const adapter = new XAdapter({
      ...baseOptions,
      maxPostsReadPerDay: 5,
      watchedAccounts: ['@a', '@b', '@c'],
      clock: newClock(),
      fetchImpl: fake.impl,
    });

    await adapter.fetchDocuments();
    const timelineCalls = fake.urls().filter((u) => u.includes('/tweets')).length;
    expect(timelineCalls).toBeLessThanOrEqual(3);
    expect(adapter.remainingReadBudget).toBeGreaterThanOrEqual(0);
  });

  it('only polls accounts that were explicitly configured', async () => {
    const fake = createFakeFetch([
      { match: '/users/by/username/', body: { data: { id: '99', name: 'Example', username: 'examplegov' } } },
      { match: '/users/99/tweets', body: { data: [] } },
    ]);
    const adapter = new XAdapter({ ...baseOptions, clock: newClock(), fetchImpl: fake.impl });
    await adapter.fetchDocuments();

    const lookups = fake.urls().filter((u) => u.includes('/users/by/username/'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toContain('examplegov');
  });
});
