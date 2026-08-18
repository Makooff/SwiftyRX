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

  /**
   * Fetch filings for every configured ticker.
   *
   * The budget is divided **per ticker**, not applied to the concatenation.
   * Truncating the combined list is order-biased in the worst possible way:
   * the tickers polled first are the chatty ones (a large cap files hundreds
   * of Form 4s a year), so a global cap is spent entirely on the head of the
   * watchlist and the tail is never seen at all. A study of "40 symbols" that
   * silently became a study of 7 is how that failure looks from the outside,
   * and nothing in the output said so.
   */
  async fetchDocuments(window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    if (!this.isConfigured()) {
      this.log.warn({}, 'CONTACT_EMAIL is not set; skipping SEC EDGAR (required by SEC policy)');
      return [];
    }
    if (this.tickers.length === 0) return [];

    const cikMap = await this.loadCikMap();
    const out: NormalizedDocument[] = [];

    const perTicker = window.limit
      ? Math.max(1, Math.floor(window.limit / this.tickers.length))
      : undefined;
    const capped: string[] = [];
    const shallow: string[] = [];

    for (const ticker of this.tickers) {
      const cik = cikMap.get(ticker);
      if (!cik) {
        this.log.debug({ ticker }, 'ticker not present in SEC mapping (non-US listing?)');
        continue;
      }
      try {
        const filings = await this.fetchFilings(ticker, cik, window);

        // The submissions index carries only a company's most recent filings.
        // When the oldest one it returned is still newer than the requested
        // start, the window is not merely small — it is incomplete, and any
        // per-period statistic computed from it is wrong rather than noisy.
        if (window.since && filings.length > 0 && !this.reachesBack(filings, window.since)) {
          shallow.push(ticker);
        }

        if (perTicker !== undefined && filings.length > perTicker) capped.push(ticker);
        out.push(...(perTicker === undefined ? filings : filings.slice(0, perTicker)));
      } catch (err) {
        this.log.warn({ ticker, error: (err as Error).message }, 'filing fetch failed');
      }
    }

    if (capped.length > 0) {
      this.log.warn(
        { perTicker, tickers: capped.slice(0, 10), count: capped.length },
        'per-ticker filing budget reached — those tickers returned an INCOMPLETE set; raise the limit',
      );
    }
    if (shallow.length > 0) {
      this.log.warn(
        { since: window.since?.toISOString(), tickers: shallow.slice(0, 10), count: shallow.length },
        "EDGAR's recent-filings index does not reach back to the requested start for these tickers — their history is INCOMPLETE",
      );
    }

    if (out.length > 0) this.lastSuccessAt = this.clock.now().toISOString();
    // Newest first across the whole set, so a downstream consumer that does
    // take a head slice takes the most recent filings rather than whichever
    // ticker happened to be polled first.
    return out.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  }

  /** Did this ticker's filings actually go back as far as was asked for? */
  private reachesBack(filings: NormalizedDocument[], since: Date): boolean {
    let oldest = Number.POSITIVE_INFINITY;
    for (const filing of filings) {
      const ms = filing.published_at ? Date.parse(filing.published_at) : Number.NaN;
      if (!Number.isNaN(ms) && ms < oldest) oldest = ms;
    }
    // A margin of one day absorbs the difference between the requested instant
    // and the first trading day that actually carried a filing.
    return oldest <= since.getTime() + 86_400_000;
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
