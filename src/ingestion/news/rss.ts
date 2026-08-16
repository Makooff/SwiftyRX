import { XMLParser } from 'fast-xml-parser';
import { type Clock, systemClock } from '../../core/clock.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import type {
  AdapterKind,
  HealthReport,
  NormalizedDocument,
  RawDocument,
  SourceDescriptor,
} from '../../domain/types.js';
import type { FeedDefinition } from '../feeds.js';
import { normalizeDocument } from '../normalize.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { DocumentSource, FetchWindow } from '../types.js';

/**
 * Generic RSS/Atom adapter.
 *
 * Used for both official press feeds and publisher news feeds. It reads only
 * what the feed publishes — title, summary, link, date. It never fetches the
 * article body, because that would mean scraping content the publisher has not
 * licensed for reuse.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

interface FeedItem {
  title?: string;
  link?: string | { '@_href'?: string } | Array<string | { '@_href'?: string }>;
  description?: string;
  summary?: string;
  content?: string;
  'content:encoded'?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
  'dc:date'?: string;
  guid?: string | { '#text'?: string };
  id?: string;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function extractLink(link: FeedItem['link']): string | undefined {
  for (const candidate of asArray(link)) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && candidate['@_href']) return candidate['@_href'];
  }
  return undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    const text = (value as Record<string, unknown>)['#text'];
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

/** Pull items out of RSS 2.0, RDF and Atom documents alike. */
export function parseFeedItems(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rssItems = doc?.rss?.channel?.item;
  if (rssItems) return asArray<FeedItem>(rssItems);
  const rdfItems = doc?.['rdf:RDF']?.item;
  if (rdfItems) return asArray<FeedItem>(rdfItems);
  const atomEntries = doc?.feed?.entry;
  if (atomEntries) return asArray<FeedItem>(atomEntries);
  return [];
}

export interface RssAdapterOptions {
  feeds: FeedDefinition[];
  userAgent: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Politeness cap; publisher feeds have no published quota. */
  requestsPerMinute?: number;
}

export class RssAdapter implements DocumentSource {
  readonly kind: AdapterKind;
  readonly requiresCredentials = false;
  readonly sources: SourceDescriptor[];

  private readonly http: HttpClient;
  private readonly feeds: FeedDefinition[];
  private readonly clock: Clock;
  private readonly log: Logger;
  private lastSuccessAt?: string;

  constructor(
    readonly id: string,
    options: RssAdapterOptions,
  ) {
    this.feeds = options.feeds;
    this.kind = this.feeds.every((f) => f.category === 'official') ? 'official' : 'news';
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('rss', { adapter: id });

    this.sources = this.feeds.map((feed) =>
      describeSource({
        id: feed.id,
        name: feed.name,
        tier: feed.tier,
        jurisdiction: feed.jurisdiction,
        url: feed.url,
        ...(feed.reliability !== undefined ? { reliability: feed.reliability } : {}),
        ...(feed.licenceNote ? { licenceNote: feed.licenceNote } : {}),
      }),
    );
    sourceRegistry.registerAll(this.sources);

    this.http = new HttpClient({
      name: id,
      defaultHeaders: { 'user-agent': options.userAgent },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(options.requestsPerMinute ?? 30, this.clock),
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return this.feeds.length > 0;
  }

  async fetchDocuments(window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    const out: NormalizedDocument[] = [];

    // Feeds are fetched in parallel; one dead feed must not stall the rest.
    const results = await Promise.allSettled(
      this.feeds.map(async (feed) => ({ feed, docs: await this.fetchFeed(feed, window) })),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        out.push(...result.value.docs);
      } else {
        this.log.warn(
          { feed: this.feeds[index]?.id, error: String(result.reason) },
          'feed fetch failed',
        );
      }
    }

    if (out.length > 0) this.lastSuccessAt = this.clock.now().toISOString();
    return window.limit ? out.slice(0, window.limit) : out;
  }

  private async fetchFeed(feed: FeedDefinition, window: FetchWindow): Promise<NormalizedDocument[]> {
    const xml = await this.http.getText(feed.url, { accept: 'text' });
    const retrievedAt = this.clock.now().toISOString();
    const items = parseFeedItems(xml);

    const docs: NormalizedDocument[] = [];
    for (const item of items) {
      const publishedAt =
        item.pubDate ?? item.published ?? item.updated ?? item['dc:date'] ?? undefined;

      if (window.since && publishedAt) {
        const ms = Date.parse(publishedAt);
        if (!Number.isNaN(ms) && ms < window.since.getTime()) continue;
      }

      const raw: RawDocument = {
        sourceId: feed.id,
        retrievedAt,
        raw: item,
        ...(extractText(item.guid) ?? item.id ? { externalId: extractText(item.guid) ?? item.id } : {}),
        ...(extractLink(item.link) ? { url: extractLink(item.link) } : {}),
        ...(item.title ? { title: extractText(item.title) ?? String(item.title) } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        content:
          extractText(item['content:encoded']) ??
          extractText(item.content) ??
          extractText(item.description) ??
          extractText(item.summary) ??
          '',
      };

      docs.push(
        normalizeDocument(raw, {
          clock: this.clock,
          metadata: { feedUrl: feed.url, feedName: feed.name, category: feed.category },
        }),
      );
    }

    return docs;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const probe = this.feeds[0];
    if (!probe) {
      return {
        adapter: this.id,
        kind: this.kind,
        state: 'disabled',
        detail: 'no feeds configured',
        checkedAt,
        requiresCredentials: false,
        credentialsPresent: true,
      };
    }

    const startedAt = this.clock.nowMs();
    try {
      const xml = await this.http.getText(probe.url, { accept: 'text', retry: false });
      const items = parseFeedItems(xml);
      return {
        adapter: this.id,
        kind: this.kind,
        state: items.length > 0 ? 'healthy' : 'degraded',
        ...(items.length === 0 ? { detail: 'feed parsed but contained no items' } : {}),
        checkedAt,
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
        requiresCredentials: false,
        credentialsPresent: true,
      };
    } catch (err) {
      return {
        adapter: this.id,
        kind: this.kind,
        state: 'unavailable',
        detail: (err as Error).message,
        checkedAt,
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
        requiresCredentials: false,
        credentialsPresent: true,
      };
    }
  }

  getStats() {
    return this.http.getStats();
  }
}
