import { type Clock, systemClock } from '../../core/clock.js';
import { DataIntegrityError } from '../../core/errors.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { TokenBucket } from '../../core/rate-limiter.js';
import type {
  AdapterKind,
  HealthReport,
  NormalizedDocument,
  SourceDescriptor,
} from '../../domain/types.js';
import { normalizeDocument } from '../normalize.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { DocumentSource, FetchWindow } from '../types.js';

/**
 * SEC EDGAR adapter (data.sec.gov).
 *
 * Verified constraints (see docs/API_RESEARCH.md):
 *  - No API key. Free.
 *  - A descriptive User-Agent carrying a contact address is mandatory;
 *    requests without one are rejected with 403.
 *  - Fair-access ceiling of 10 requests/second across all of EDGAR. We run at
 *    5/s to leave headroom.
 *
 * Filings are the highest-tier source in this system: a company's own 8-K is
 * as close to ground truth as market information gets.
 */

const SEC_RATE_PER_SECOND = 5; // half the published 10/s ceiling

/** Filing forms worth reacting to. Anything else is ingested but low-priority. */
export const MARKET_MOVING_FORMS = new Set([
  '8-K', // material events
  '6-K', // foreign private issuer material events
  '10-Q',
  '10-K',
  '20-F',
  'SC 13D',
  'SC 13G',
  '4', // insider transactions
  '425',
  'DEFM14A',
]);

interface SubmissionsResponse {
  cik: string;
  name: string;
  tickers?: string[];
  exchanges?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      acceptanceDateTime?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
      reportDate?: string[];
      items?: string[];
    };
  };
}

interface TickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

export interface SecEdgarOptions {
  /** "AppName contact@example.com" — required by the SEC. */
  userAgent: string;
  contactEmail?: string;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  /** Tickers to poll. Defaults to the configured watchlist. */
  tickers?: string[];
}

export const SEC_SOURCE: SourceDescriptor = describeSource({
  id: 'sec_edgar',
  name: 'SEC EDGAR — company filings',
  tier: 'regulatory_filing',
  jurisdiction: 'US',
  url: 'https://www.sec.gov/edgar',
  licenceNote: 'Public domain US government data. Fair-access limit: 10 req/s.',
});

export class SecEdgarAdapter implements DocumentSource {
  readonly kind: AdapterKind = 'official';
  readonly requiresCredentials = false;
  readonly sources = [SEC_SOURCE];
  readonly id = 'sec_edgar';

  private readonly dataHttp: HttpClient;
  private readonly wwwHttp: HttpClient;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly contactEmail?: string;
  private tickers: string[];
  private cikByTicker?: Map<string, string>;
  private lastSuccessAt?: string;

  constructor(options: SecEdgarOptions) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('sec-edgar');
    this.tickers = (options.tickers ?? []).map((t) => t.toUpperCase());
    if (options.contactEmail) this.contactEmail = options.contactEmail;
    sourceRegistry.register(SEC_SOURCE);

    // EDGAR's rate limit is enforced per IP across both hosts, so the two
    // clients share one bucket.
    const bucket = new TokenBucket(SEC_RATE_PER_SECOND, SEC_RATE_PER_SECOND, this.clock);
    const shared = {
      defaultHeaders: {
        'user-agent': options.userAgent,
        'accept-encoding': 'gzip, deflate',
      },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: bucket,
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };

    this.dataHttp = new HttpClient({ ...shared, name: 'sec_edgar_data', baseUrl: 'https://data.sec.gov' });
    this.wwwHttp = new HttpClient({ ...shared, name: 'sec_edgar_www', baseUrl: 'https://www.sec.gov' });
  }

  /**
   * The SEC rejects requests whose User-Agent lacks a contact address. We
   * refuse to send them at all rather than get the operator's IP blocked.
   */
  isConfigured(): boolean {
    return Boolean(this.contactEmail && /.+@.+\..+/.test(this.contactEmail));
  }

  setTickers(tickers: string[]): void {
    this.tickers = tickers.map((t) => t.toUpperCase());
  }

  /** Ticker -> zero-padded CIK, from the SEC's own published mapping file. */
  async loadCikMap(): Promise<Map<string, string>> {
    if (this.cikByTicker) return this.cikByTicker;

    const payload = await this.wwwHttp.getJson<Record<string, TickerEntry>>('/files/company_tickers.json');
    const map = new Map<string, string>();
    for (const entry of Object.values(payload)) {
      if (!entry?.ticker || entry.cik_str === undefined) continue;
      map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
    }
    if (map.size === 0) {
      throw new DataIntegrityError('SEC company_tickers.json contained no usable entries');
    }
    this.cikByTicker = map;
    return map;
  }

  async fetchDocuments(window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    if (!this.isConfigured()) {
      this.log.warn({}, 'CONTACT_EMAIL is not set; skipping SEC EDGAR (required by SEC policy)');
      return [];
    }
    if (this.tickers.length === 0) return [];

    const cikMap = await this.loadCikMap();
    const out: NormalizedDocument[] = [];

    for (const ticker of this.tickers) {
      const cik = cikMap.get(ticker);
      if (!cik) {
        this.log.debug({ ticker }, 'ticker not present in SEC mapping (non-US listing?)');
        continue;
      }
      try {
        out.push(...(await this.fetchFilings(ticker, cik, window)));
      } catch (err) {
        this.log.warn({ ticker, error: (err as Error).message }, 'filing fetch failed');
      }
    }

    if (out.length > 0) this.lastSuccessAt = this.clock.now().toISOString();
    return window.limit ? out.slice(0, window.limit) : out;
  }

  private async fetchFilings(
    ticker: string,
    cik: string,
    window: FetchWindow,
  ): Promise<NormalizedDocument[]> {
    const payload = await this.dataHttp.getJson<SubmissionsResponse>(`/submissions/CIK${cik}.json`);
    const recent = payload.filings?.recent;
    if (!recent?.accessionNumber) return [];

    const retrievedAt = this.clock.now().toISOString();
    const docs: NormalizedDocument[] = [];
    const count = recent.accessionNumber.length;

    for (let i = 0; i < count; i++) {
      const accession = recent.accessionNumber[i];
      const form = recent.form?.[i] ?? 'UNKNOWN';
      if (!accession) continue;

      // acceptanceDateTime is when the filing became public — the only
      // timestamp safe to treat as the information's arrival time.
      const acceptance = recent.acceptanceDateTime?.[i];
      const filingDate = recent.filingDate?.[i];
      const publishedAt = acceptance ?? (filingDate ? `${filingDate}T00:00:00Z` : undefined);

      if (window.since && publishedAt) {
        const ms = Date.parse(publishedAt);
        if (!Number.isNaN(ms) && ms < window.since.getTime()) continue;
      }

      const bare = accession.replace(/-/g, '');
      const primaryDoc = recent.primaryDocument?.[i];
      const url = primaryDoc
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${primaryDoc}`
        : `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/`;

      const description = recent.primaryDocDescription?.[i] ?? '';
      const items = recent.items?.[i] ?? '';

      docs.push(
        normalizeDocument(
          {
            sourceId: SEC_SOURCE.id,
            externalId: accession,
            url,
            title: `${payload.name} filed ${form}${description ? ` — ${description}` : ''}`,
            // The submissions index gives metadata only. Document text is
            // fetched later, on demand, for filings that matter.
            content: [
              `Form ${form} filed by ${payload.name} (CIK ${cik}).`,
              items ? `Reported items: ${items}.` : '',
              recent.reportDate?.[i] ? `Report date: ${recent.reportDate[i]}.` : '',
            ]
              .filter(Boolean)
              .join(' '),
            ...(publishedAt ? { publishedAt } : {}),
            retrievedAt,
            raw: {
              accession,
              form,
              filingDate,
              acceptanceDateTime: acceptance,
              items,
              cik,
            },
          },
          {
            clock: this.clock,
            declaredTickers: [ticker],
            metadata: {
              form,
              cik,
              companyName: payload.name,
              marketMoving: MARKET_MOVING_FORMS.has(form),
              items: items ? items.split(',').map((s) => s.trim()) : [],
            },
          },
        ),
      );
    }

    return docs;
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const base = {
      adapter: this.id,
      kind: this.kind,
      checkedAt,
      requiresCredentials: false,
      credentialsPresent: this.isConfigured(),
    };

    if (!this.isConfigured()) {
      return {
        ...base,
        state: 'disabled',
        detail: 'CONTACT_EMAIL not set — SEC requires a contact address in the User-Agent header',
      };
    }

    const startedAt = this.clock.nowMs();
    try {
      const map = await this.loadCikMap();
      return {
        ...base,
        state: map.size > 0 ? 'healthy' : 'degraded',
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      };
    } catch (err) {
      return {
        ...base,
        state: 'unavailable',
        detail: (err as Error).message,
        latencyMs: this.clock.nowMs() - startedAt,
        ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      };
    }
  }

  getStats() {
    return { data: this.dataHttp.getStats(), www: this.wwwHttp.getStats() };
  }
}
