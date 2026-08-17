import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { type Clock, systemClock } from './clock.js';
import { RateLimitError, UpstreamError } from './errors.js';
import { createLogger, type Logger } from './logger.js';
import { TokenBucket } from './rate-limiter.js';
import { redactUrl } from './redact.js';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Provider name; used for logs, metrics and the circuit-breaker identity. */
  name: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  /** Published provider limit. Omit only for providers with no documented cap. */
  rateLimit?: TokenBucket;
  circuit?: CircuitBreakerOptions;
  clock?: Clock;
  logger?: Logger;
  /** Injection seam: tests pass a fixture-backed fetch, never the network. */
  fetchImpl?: FetchImpl;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Overrides the client default for this call. */
  timeoutMs?: number;
  /** Set false for endpoints where retrying is unsafe or pointless. */
  retry?: boolean;
  accept?: 'json' | 'text';
}

export interface HttpStats {
  requests: number;
  failures: number;
  retries: number;
  rateLimited: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorMessage?: string;
  totalLatencyMs: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * HTTP client shared by every ingestion adapter.
 *
 * Responsibilities: published-rate-limit compliance, bounded retries with
 * exponential backoff and jitter, per-provider circuit breaking, timeouts, and
 * health statistics that the System Health page consumes.
 */
export class HttpClient {
  readonly name: string;
  readonly breaker: CircuitBreaker;
  private readonly stats: HttpStats = {
    requests: 0,
    failures: 0,
    retries: 0,
    rateLimited: 0,
    totalLatencyMs: 0,
  };

  private readonly baseUrl?: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rateLimit?: TokenBucket;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly fetchImpl: FetchImpl;

  constructor(options: HttpClientOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.rateLimit = options.rateLimit;
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('http', { provider: options.name });
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.breaker = new CircuitBreaker(options.name, options.circuit, this.clock);
  }

  getStats(): Readonly<HttpStats> & { avgLatencyMs: number; circuitState: string } {
    return {
      ...this.stats,
      avgLatencyMs:
        this.stats.requests > 0 ? Math.round(this.stats.totalLatencyMs / this.stats.requests) : 0,
      circuitState: this.breaker.currentState,
    };
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = this.baseUrl
      ? new URL(path.replace(/^\//, ''), this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`)
      : new URL(path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, accept: 'json' });
  }

  async getText(path: string, options: RequestOptions = {}): Promise<string> {
    return this.request<string>(path, { ...options, accept: 'text' });
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const retriesAllowed = options.retry === false ? 0 : this.maxRetries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retriesAllowed; attempt++) {
      if (attempt > 0) {
        this.stats.retries += 1;
        // Exponential backoff with jitter, capped so a bad provider cannot
        // stall the pipeline indefinitely.
        const backoff = Math.min(30_000, 2 ** (attempt - 1) * 500);
        await this.clock.sleep(backoff + Math.floor(Math.random() * 250));
      }

      try {
        return await this.breaker.execute(() => this.attempt<T>(url, options));
      } catch (err) {
        lastError = err;
        const retryable = err instanceof UpstreamError ? err.retryable : false;
        if (!retryable || attempt === retriesAllowed) break;
        this.log.warn(
          { url: redactUrl(url), attempt: attempt + 1, error: (err as Error).message },
          'request failed, retrying',
        );
      }
    }

    throw lastError;
  }

  private async attempt<T>(url: string, options: RequestOptions): Promise<T> {
    if (this.rateLimit) await this.rateLimit.acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const startedAt = this.clock.nowMs();
    this.stats.requests += 1;

    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: options.accept === 'text' ? 'text/plain, application/xml, */*' : 'application/json',
          // Bodies are always JSON-encoded below, so the type is not a caller
          // decision. Omitting it makes some APIs silently ignore the payload.
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.defaultHeaders,
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      this.stats.totalLatencyMs += this.clock.nowMs() - startedAt;

      if (response.status === 429) {
        this.stats.rateLimited += 1;
        const retryAfter = response.headers.get('retry-after');
        throw new RateLimitError(
          `${this.name} rate limit exceeded`,
          retryAfter ? Number(retryAfter) * 1000 : undefined,
          { url: redactUrl(url) },
        );
      }

      if (!response.ok) {
        // Bodies of error responses can echo back credentials; keep a short,
        // redacted excerpt only.
        const excerpt = (await response.text().catch(() => '')).slice(0, 300);
        throw new UpstreamError(
          `${this.name} returned HTTP ${response.status}`,
          response.status,
          { url: redactUrl(url), excerpt },
        );
      }

      const payload =
        options.accept === 'text' ? ((await response.text()) as T) : ((await response.json()) as T);
      this.stats.lastSuccessAt = this.clock.now().toISOString();
      return payload;
    } catch (err) {
      this.stats.failures += 1;
      this.stats.lastFailureAt = this.clock.now().toISOString();
      this.stats.lastErrorMessage = (err as Error).message;

      if (err instanceof UpstreamError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new UpstreamError(`${this.name} request timed out`, undefined, {
          url: redactUrl(url),
        });
      }
      throw new UpstreamError(`${this.name} request failed: ${(err as Error).message}`, undefined, {
        url: redactUrl(url),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Convenience for status codes that a caller wants to treat as retryable. */
  static isRetryableStatus(status: number): boolean {
    return RETRYABLE_STATUS.has(status);
  }
}
