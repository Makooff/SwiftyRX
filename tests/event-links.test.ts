import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/core/clock.js';
import type { NormalizedDocument } from '../src/domain/types.js';
import { normalizeDocument } from '../src/ingestion/normalize.js';
import { describeSource, sourceRegistry } from '../src/ingestion/source-registry.js';
import { linksFor } from '../src/intelligence/pipeline.js';
import { renderDashboard, type DashboardData } from '../apps/dashboard/render.js';

/**
 * Links back to the source.
 *
 * An event is our summary of documents we did not write. Without a way to open
 * the original, every judgement the system makes about it is unfalsifiable from
 * the outside — which is the opposite of the point.
 *
 * The adversarial case is that the URL itself is hostile: feed items are
 * attacker-controlled text as far as this code is concerned.
 */

const clock = FixedClock.at('2026-08-19T12:00:00Z');

sourceRegistry.clear();
sourceRegistry.registerAll([
  describeSource({ id: 'sec_edgar', name: 'SEC', tier: 'regulatory_filing', jurisdiction: 'US' }),
  describeSource({ id: 'outlet_a', name: 'A', tier: 'news', jurisdiction: 'US' }),
]);

function doc(source: string, title: string, url?: string): NormalizedDocument {
  return normalizeDocument(
    {
      sourceId: source,
      externalId: `${source}:${title}`,
      title,
      content: 'body',
      ...(url ? { url } : {}),
      publishedAt: '2026-08-19T10:00:00Z',
      retrievedAt: clock.now().toISOString(),
      raw: {},
    },
    { clock },
  );
}

describe('collecting the documents behind an event', () => {
  it('carries source, title and url through', () => {
    const links = linksFor([doc('sec_edgar', 'Apple 8-K', 'https://www.sec.gov/a.htm')]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      source: 'sec_edgar',
      title: 'Apple 8-K',
      url: 'https://www.sec.gov/a.htm',
    });
  });

  it('skips a document whose source published no url', () => {
    // Better an event that looks like it has no readable source than a link
    // that goes nowhere.
    expect(linksFor([doc('outlet_a', 'No link here')])).toHaveLength(0);
  });

  it('counts one story once however many outlets carry it', () => {
    const same = 'https://example.com/story';
    const links = linksFor([
      doc('outlet_a', 'Story', same),
      doc('sec_edgar', 'Story again', same),
    ]);
    expect(links).toHaveLength(1);
  });

  it('caps a large cluster rather than listing all of it', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      doc('outlet_a', `Story ${i}`, `https://example.com/${i}`),
    );
    expect(linksFor(many).length).toBeLessThanOrEqual(6);
  });
});

/** Minimal data whose only interesting part is the one event. */
function dataWith(url: string): DashboardData {
  return {
    mode: 'paper',
    paperTrading: true,
    liveTrading: false,
    currency: 'EUR',
    portfolio: {
      initialCapital: 10_000,
      totalValue: 10_000,
      cash: 10_000,
      totalReturnPct: 0,
      drawdownPct: 0,
      maxDrawdownPct: 0,
      exposurePct: 0,
      positions: [],
    },
    funnels: [],
    signals: [],
    events: [
      {
        id: 'evt1',
        type: 'earnings',
        headline: 'Apple Inc. filed 8-K',
        summary: 'Results.',
        firstSeenAt: '2026-08-19T10:00:00Z',
        lastUpdatedAt: '2026-08-19T10:00:00Z',
        entities: [],
        tickers: ['AAPL'],
        jurisdictions: ['US'],
        documentIds: ['d1'],
        sources: ['sec_edgar'],
        links: [{ source: 'sec_edgar', title: 'Filing', url, publishedAt: null }],
        classification: { type: 'earnings', confidence: 0.9, matched: [] },
        materiality: 0.7,
        verification: {
          status: 'officially_confirmed',
          confidence: 0.9,
          distinctSources: 1,
          independentReports: 1,
          authoritativeSources: ['sec_edgar'],
          contradictions: [],
          reasons: [],
        },
      },
    ],
    orders: [],
    health: [],
    agent: {
      cycles: 1,
      documentsIngested: 1,
      eventsDetected: 1,
      signalsGenerated: 0,
      ordersPlaced: 0,
      ordersRejectedByRisk: 0,
      halted: false,
      haltReasons: [],
      errors: [],
    } as unknown as DashboardData['agent'],
    activity: [],
    settings: [],
    exitPlans: [],
    outcomes: { rates: {}, pending: 0 },
    unmeasurableEventTypes: [],
    llmProvider: 'none',
  };
}

describe('rendering a link that came from a feed', () => {
  it('links an ordinary https url', () => {
    const html = renderDashboard(dataWith('https://www.sec.gov/filing.htm'));
    expect(html).toContain('href="https://www.sec.gov/filing.htm"');
  });

  it('opens it in a new tab without handing over the opener', () => {
    const html = renderDashboard(dataWith('https://www.sec.gov/filing.htm'));
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });

  it('refuses to make a javascript: url clickable', () => {
    // A feed item is text we did not write. Without this, clicking a headline
    // on your own dashboard runs whatever the feed put there.
    const html = renderDashboard(dataWith('javascript:alert(document.cookie)'));
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('alert(document.cookie)');
  });

  it('refuses a data: url too', () => {
    const html = renderDashboard(dataWith('data:text/html,<script>alert(1)</script>'));
    expect(html).not.toContain('href="data:');
  });

  it('names the source anyway when the url is unusable', () => {
    // Dropping the row entirely would hide that the event had a document.
    const html = renderDashboard(dataWith('javascript:void(0)'));
    expect(html).toContain('sec_edgar');
  });

  it('shows the category next to the headline', () => {
    const html = renderDashboard(dataWith('https://www.sec.gov/filing.htm'));
    expect(html).toMatch(/class="cat">earnings</);
  });
});
