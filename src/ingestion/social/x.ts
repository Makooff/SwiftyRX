import { type Clock, systemClock } from '../../core/clock.js';
import { BudgetExceededError } from '../../core/errors.js';
import { HttpClient, type FetchImpl } from '../../core/http.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { DailyQuota, TokenBucket } from '../../core/rate-limiter.js';
import { registerSecret } from '../../core/redact.js';
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
 * X (Twitter) adapter — OFF by default, metered, and never authoritative.
 *
 * Verified constraints (see docs/API_RESEARCH.md), as of the research date in
 * that document:
 *  - X discontinued the free API tier for new developers in February 2026 and
 *    moved to pay-per-use. Reads are billed per post (~$0.005 at the rates
 *    published in mid-2026). Legacy flat Basic/Pro plans exist only for
 *    existing subscribers.
 *  - Therefore every read here costs the operator money. The adapter enforces
 *    a hard daily read budget and refuses to run when it is exhausted.
 *
 * Trust model — the part that matters more than the plumbing:
 *  - Only explicitly listed accounts are polled. There is no keyword firehose,
 *    no trending scrape, no "influencer discovery".
 *  - Posts enter as tier `social` with a low reliability prior and
 *    verification status `unverified`.
 *  - `canTriggerOrderDirectly: false` is stamped on every document. A post is
 *    a lead to investigate against official sources, never a trade trigger.
 *    Accounts get compromised, parodied and spoofed; an account handle is not
 *    evidence about the world.
 */

const X_API_BASE = 'https://api.x.com/2/';
/** Self-imposed pacing; the billing model, not a rate limit, is the real cap. */
const X_SELF_IMPOSED_RPM = 15;

interface XUserResponse {
  data?: { id: string; name: string; username: string; verified?: boolean };
  errors?: Array<{ detail?: string; title?: string }>;
}

interface XTimelineResponse {
  data?: Array<{
    id: string;
    text: string;
    created_at?: string;
    author_id?: string;
    referenced_tweets?: Array<{ type: string; id: string }>;
    entities?: {
      cashtags?: Array<{ tag: string }>;
      urls?: Array<{ expanded_url?: string }>;
    };
  }>;
  meta?: { result_count?: number; newest_id?: string };
  errors?: Array<{ detail?: string; title?: string }>;
}

export interface XAdapterOptions {
  bearerToken?: string;
  /** Handles to poll, with or without a leading "@". Never inferred. */
  watchedAccounts: string[];
  /** Hard ceiling on billed post reads per day. 0 disables reads entirely. */
  maxPostsReadPerDay: number;
  enabled: boolean;
  clock?: Clock;
  logger?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

function normaliseHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

export function describeXAccount(handle: string): SourceDescriptor {
  const clean = normaliseHandle(handle);
  return describeSource({
    id: `x:@${clean}`,
    name: `X account @${clean}`,
    tier: 'social',
    // Below the social baseline: a single post from any account, however
    // prominent, is not evidence until something else confirms it.
    reliability: 0.2,
    authoritative: false,
    url: `https://x.com/${clean}`,
    licenceNote: 'X API content is subject to the X Developer Agreement; reads are billed per post.',
  });
}

export class XAdapter implements DocumentSource {
  readonly kind: AdapterKind = 'social';
  readonly id = 'x';
  readonly requiresCredentials = true;
  readonly sources: SourceDescriptor[];

  private readonly http: HttpClient;
  private readonly bearerToken?: string;
  private readonly watchedAccounts: string[];
  private readonly enabled: boolean;
  private readonly readBudget: DailyQuota;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly userIdCache = new Map<string, string>();
  private lastSuccessAt?: string;

  constructor(options: XAdapterOptions) {
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('x');
    this.enabled = options.enabled;
    this.watchedAccounts = options.watchedAccounts.map(normaliseHandle).filter(Boolean);
    this.readBudget = new DailyQuota(options.maxPostsReadPerDay, this.clock);
    if (options.bearerToken) {
      this.bearerToken = options.bearerToken;
      registerSecret(options.bearerToken);
    }

    this.sources = this.watchedAccounts.map(describeXAccount);
    sourceRegistry.registerAll(this.sources);

    this.http = new HttpClient({
      name: 'x',
      baseUrl: X_API_BASE,
      defaultHeaders: this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {},
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      rateLimit: TokenBucket.perMinute(X_SELF_IMPOSED_RPM, this.clock),
      // Reads cost money: one retry, not three.
      maxRetries: 1,
      clock: this.clock,
      logger: this.log,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  isConfigured(): boolean {
    return (
      this.enabled &&
      Boolean(this.bearerToken) &&
      this.watchedAccounts.length > 0 &&
      this.readBudget.limit > 0
    );
  }

  get remainingReadBudget(): number {
    return this.readBudget.remaining;
  }

  private async resolveUserId(handle: string): Promise<string | undefined> {
    const cached = this.userIdCache.get(handle);
    if (cached) return cached;

    const payload = await this.http.getJson<XUserResponse>(`users/by/username/${handle}`);
    const id = payload.data?.id;
    if (!id) {
      this.log.warn({ handle, errors: payload.errors }, 'could not resolve X handle');
      return undefined;
    }
    this.userIdCache.set(handle, id);
    return id;
  }

  async fetchDocuments(window: FetchWindow = {}): Promise<NormalizedDocument[]> {
    if (!this.isConfigured()) {
      this.log.debug({}, 'X ingestion disabled or unconfigured; skipping');
      return [];
    }

    const perAccount = Math.max(
      5,
      Math.min(100, Math.floor((window.limit ?? 20) / Math.max(1, this.watchedAccounts.length))),
    );
    const out: NormalizedDocument[] = [];

    for (const handle of this.watchedAccounts) {
      if (!this.readBudget.canSpend(perAccount)) {
        this.log.warn(
          { handle, remaining: this.readBudget.remaining },
          'daily X read budget exhausted; stopping',
        );
        break;
      }

      try {
        out.push(...(await this.fetchAccount(handle, perAccount, window)));
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        this.log.warn({ handle, error: (err as Error).message }, 'X timeline fetch failed');
      }
    }

    if (out.length > 0) this.lastSuccessAt = this.clock.now().toISOString();
    return out;
  }

  private async fetchAccount(
    handle: string,
    maxResults: number,
    window: FetchWindow,
  ): Promise<NormalizedDocument[]> {
    const userId = await this.resolveUserId(handle);
    if (!userId) return [];

    const payload = await this.http.getJson<XTimelineResponse>(`users/${userId}/tweets`, {
      query: {
        max_results: Math.max(5, Math.min(100, maxResults)),
        'tweet.fields': 'created_at,entities,referenced_tweets',
        ...(window.since ? { start_time: window.since.toISOString() } : {}),
      },
    });

    const posts = payload.data ?? [];
    // Bill what we actually read.
    this.readBudget.spend(posts.length);

    const retrievedAt = this.clock.now().toISOString();
    const sourceId = `x:@${handle}`;

    return posts.map((post) =>
      normalizeDocument(
        {
          sourceId,
          externalId: post.id,
          url: `https://x.com/${handle}/status/${post.id}`,
          title: post.text.slice(0, 200),
          content: post.text,
          ...(post.created_at ? { publishedAt: post.created_at } : {}),
          retrievedAt,
          raw: post,
        },
        {
          clock: this.clock,
          declaredTickers: (post.entities?.cashtags ?? []).map((c) => c.tag.toUpperCase()),
          metadata: {
            handle,
            authorId: post.author_id ?? userId,
            isReply: post.referenced_tweets?.some((r) => r.type === 'replied_to') ?? false,
            isRepost: post.referenced_tweets?.some((r) => r.type === 'retweeted') ?? false,
            linkedUrls: (post.entities?.urls ?? []).map((u) => u.expanded_url).filter(Boolean),
            // Read by the strategy layer: a social post can never be the sole
            // basis for an order, regardless of how confident a model is.
            canTriggerOrderDirectly: false,
            requiresCorroboration: true,
          },
        },
      ),
    );
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.clock.now().toISOString();
    const base = {
      adapter: this.id,
      kind: this.kind,
      checkedAt,
      requiresCredentials: true,
      credentialsPresent: Boolean(this.bearerToken),
    };

    if (!this.enabled) {
      return { ...base, state: 'disabled', detail: 'ENABLE_X_INGESTION=false (default)' };
    }
    if (!this.bearerToken) {
      return { ...base, state: 'disabled', detail: 'X_BEARER_TOKEN not set' };
    }
    if (this.watchedAccounts.length === 0) {
      return { ...base, state: 'disabled', detail: 'X_WATCHED_ACCOUNTS is empty' };
    }
    if (this.readBudget.remaining === 0) {
      return { ...base, state: 'degraded', detail: 'daily read budget exhausted' };
    }

    // Resolving a handle is a billed user-lookup call, so health reports
    // configuration state rather than spending the operator's money.
    return {
      ...base,
      state: 'healthy',
      detail: `enabled for ${this.watchedAccounts.length} account(s); ${this.readBudget.remaining} reads left today (not probed — reads are billed)`,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
    };
  }

  getStats() {
    return { ...this.http.getStats(), readBudgetRemaining: this.readBudget.remaining };
  }
}
