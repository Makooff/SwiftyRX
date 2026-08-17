import type { FetchImpl } from '../../src/core/http.js';

/**
 * Fixture-backed fetch.
 *
 * Every adapter test runs against this. No test in this repository is allowed
 * to touch the network: a test suite whose outcome depends on a third party's
 * uptime tells you nothing about your own code.
 */

export interface FakeRoute {
  /** Substring or regex matched against the full request URL. */
  match: string | RegExp;
  status?: number;
  body?: unknown;
  /** Raw body, for XML/CSV endpoints. */
  text?: string;
  headers?: Record<string, string>;
  /** Fail with a network-level error instead of an HTTP response. */
  networkError?: boolean;
}

export interface FakeFetch {
  impl: FetchImpl;
  calls: Array<{ url: string; init?: RequestInit }>;
  /** URLs seen so far, in order. */
  urls(): string[];
}

export function createFakeFetch(routes: FakeRoute[]): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const impl: FetchImpl = async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });

    const route = routes.find((r) =>
      typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url),
    );

    if (!route) {
      return new Response(JSON.stringify({ error: 'no fixture for this URL' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.networkError) {
      throw new TypeError('fetch failed');
    }

    const status = route.status ?? 200;
    // 204/205/304 must carry a null body — Node's Response constructor throws
    // on anything else, which a test would otherwise see as a network failure.
    const body =
      status === 204 || status === 205 || status === 304
        ? null
        : route.text !== undefined
          ? route.text
          : JSON.stringify(route.body ?? {});
    return new Response(body, {
      status,
      headers: {
        'content-type': route.text !== undefined ? 'text/xml' : 'application/json',
        ...route.headers,
      },
    });
  };

  return { impl, calls, urls: () => calls.map((c) => c.url) };
}
