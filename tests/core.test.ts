import { beforeEach, describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/core/circuit-breaker.js';
import { FixedClock } from '../src/core/clock.js';
import { CircuitOpenError, UpstreamError } from '../src/core/errors.js';
import { HttpClient } from '../src/core/http.js';
import { MemoryCache } from '../src/core/cache.js';
import { DailyQuota, TokenBucket } from '../src/core/rate-limiter.js';
import { redact, redactUrl, registerSecret, resetSecrets } from '../src/core/redact.js';
import { createFakeFetch } from './helpers/fake-fetch.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const bucket = TokenBucket.perMinute(60, clock);
    for (let i = 0; i < 60; i++) expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
  });

  it('refills over time at the published rate', () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const bucket = TokenBucket.perMinute(60, clock); // 1 per second
    for (let i = 0; i < 60; i++) bucket.tryAcquire();
    expect(bucket.tryAcquire()).toBe(false);
    clock.advance(2000);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
  });

  it('reports how long the caller must wait', () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const bucket = TokenBucket.perMinute(60, clock);
    for (let i = 0; i < 60; i++) bucket.tryAcquire();
    expect(bucket.waitTimeMs()).toBeGreaterThan(0);
    expect(bucket.waitTimeMs()).toBeLessThanOrEqual(1000);
  });
});

describe('DailyQuota', () => {
  it('refuses to spend beyond the configured budget', () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const quota = new DailyQuota(10, clock);
    quota.spend(10);
    expect(quota.canSpend()).toBe(false);
    expect(quota.remaining).toBe(0);
  });

  it('rolls over after 24 hours', () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const quota = new DailyQuota(5, clock);
    quota.spend(5);
    expect(quota.canSpend()).toBe(false);
    clock.advance(24 * 3600 * 1000 + 1);
    expect(quota.canSpend()).toBe(true);
  });

  it('treats a zero budget as fully disabled', () => {
    const quota = new DailyQuota(0, FixedClock.at('2026-01-01T00:00:00Z'));
    expect(quota.canSpend()).toBe(false);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and rejects further calls', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const breaker = new CircuitBreaker('test', { failureThreshold: 3 }, clock);
    const boom = () => Promise.reject(new Error('upstream down'));

    for (let i = 0; i < 3; i++) await expect(breaker.execute(boom)).rejects.toThrow('upstream down');
    expect(breaker.currentState).toBe('open');
    await expect(breaker.execute(async () => 'ok')).rejects.toThrow(CircuitOpenError);
  });

  it('half-opens after the reset timeout and closes on success', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const breaker = new CircuitBreaker(
      'test',
      { failureThreshold: 1, resetTimeoutMs: 1000, successThreshold: 1 },
      clock,
    );
    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
    expect(breaker.currentState).toBe('open');

    clock.advance(1001);
    expect(breaker.currentState).toBe('half_open');
    await expect(breaker.execute(async () => 'recovered')).resolves.toBe('recovered');
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens immediately when the probe fails', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, resetTimeoutMs: 500 }, clock);
    await expect(breaker.execute(() => Promise.reject(new Error('down')))).rejects.toThrow();
    clock.advance(501);
    await expect(breaker.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow();
    expect(breaker.currentState).toBe('open');
  });
});

describe('secret redaction', () => {
  beforeEach(() => resetSecrets());

  it('strips credential-bearing query parameters from URLs', () => {
    const url = 'https://api.example.com/data?symbol=AAPL&apikey=super-secret-value';
    expect(redactUrl(url)).toContain('symbol=AAPL');
    expect(redactUrl(url)).not.toContain('super-secret-value');
  });

  it('redacts registered secret literals wherever they appear', () => {
    registerSecret('sk-live-abcdef123456');
    const result = redact({ note: 'token is sk-live-abcdef123456 in the body' }) as {
      note: string;
    };
    expect(result.note).not.toContain('sk-live-abcdef123456');
  });

  it('redacts secret-looking object keys', () => {
    const result = redact({
      apiKey: 'aaaaaaaaaaaa',
      nested: { authorization: 'Bearer xyz', symbol: 'NVDA' },
    }) as Record<string, any>;
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.nested.authorization).toBe('[REDACTED]');
    expect(result.nested.symbol).toBe('NVDA');
  });
});

describe('HttpClient', () => {
  it('retries retryable failures and eventually succeeds', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    let attempts = 0;
    const client = new HttpClient({
      name: 'test',
      baseUrl: 'https://api.example.com/',
      clock,
      maxRetries: 3,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return new Response('server error', { status: 503 });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(client.getJson<{ ok: boolean }>('endpoint')).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
    expect(client.getStats().retries).toBe(2);
  });

  it('does not retry client errors', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    let attempts = 0;
    const client = new HttpClient({
      name: 'test',
      baseUrl: 'https://api.example.com/',
      clock,
      fetchImpl: async () => {
        attempts += 1;
        return new Response('bad request', { status: 400 });
      },
    });

    await expect(client.getJson('endpoint')).rejects.toThrow(UpstreamError);
    expect(attempts).toBe(1);
  });

  it('surfaces 429 as a rate limit error', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const client = new HttpClient({
      name: 'test',
      baseUrl: 'https://api.example.com/',
      clock,
      maxRetries: 0,
      fetchImpl: async () => new Response('slow down', { status: 429 }),
    });

    await expect(client.getJson('endpoint')).rejects.toThrow(/rate limit/i);
    expect(client.getStats().rateLimited).toBe(1);
  });

  it('treats a network failure as retryable and reports it', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const fake = createFakeFetch([{ match: 'example.com', networkError: true }]);
    const client = new HttpClient({
      name: 'test',
      baseUrl: 'https://api.example.com/',
      clock,
      maxRetries: 1,
      fetchImpl: fake.impl,
    });

    await expect(client.getJson('endpoint')).rejects.toThrow(UpstreamError);
    expect(fake.calls.length).toBe(2);
    expect(client.getStats().failures).toBe(2);
  });

  it('never leaks the API key into the error message', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    registerSecret('secret-key-value-1234');
    const client = new HttpClient({
      name: 'test',
      baseUrl: 'https://api.example.com/',
      clock,
      maxRetries: 0,
      fetchImpl: async () => new Response('denied', { status: 401 }),
    });

    try {
      await client.getJson('endpoint', { query: { apikey: 'secret-key-value-1234' } });
      throw new Error('expected the request to fail');
    } catch (err) {
      const serialised = JSON.stringify((err as UpstreamError).context);
      expect(serialised).not.toContain('secret-key-value-1234');
    }
  });
});

describe('MemoryCache', () => {
  it('expires entries after the TTL', async () => {
    const clock = FixedClock.at('2026-01-01T00:00:00Z');
    const cache = new MemoryCache(clock);
    await cache.set('key', 'value', 60);
    expect(await cache.get('key')).toBe('value');
    clock.advance(61_000);
    expect(await cache.get('key')).toBeUndefined();
  });

  it('evicts the oldest entries past the size limit', async () => {
    const cache = new MemoryCache(FixedClock.at('2026-01-01T00:00:00Z'), 2);
    await cache.set('a', 1, 600);
    await cache.set('b', 2, 600);
    await cache.set('c', 3, 600);
    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(await cache.get('c')).toBe(3);
  });
});
