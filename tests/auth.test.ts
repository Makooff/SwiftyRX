import { describe, expect, it } from 'vitest';
import { createApiServer } from '../apps/api/server.js';
import { assertExposureIsSafe, looksPubliclyRouted, UnsafeExposureError } from '../apps/api/auth.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { FixedClock } from '../src/core/clock.js';
import { TradingAgent } from '../apps/worker/agent.js';
import { Deduplicator } from '../src/ingestion/dedup.js';
import { FixtureMarketDataAdapter } from '../src/ingestion/market_data/fixture.js';
import { MarketDataService } from '../src/ingestion/market_data/index.js';
import type { IngestionStack } from '../src/ingestion/pipeline.js';

/**
 * Dashboard exposure.
 *
 * The dashboard is read-only, so the risk is not that a stranger trades — it is
 * that a stranger reads a live portfolio, its positions and every signal. The
 * property under test is that publishing it requires a password, and that
 * forgetting one fails loudly rather than quietly serving the page.
 */

const clock = FixedClock.at('2026-08-16T12:00:00Z');
const PASSWORD = 'a-long-enough-password';

function emptyStack(): IngestionStack {
  return {
    documentSources: [],
    macroSources: [],
    marketData: new MarketDataService({
      providers: [new FixtureMarketDataAdapter({ clock, basePrices: { AAPL: 200 } })],
      maxStalenessSeconds: 120,
      clock,
    }),
    adapters: [],
    deduplicator: new Deduplicator({ clock }),
  };
}

function agentFor(env: Record<string, string> = {}) {
  // Hermetic: a study run on the developer's own machine writes a real
  // evidence book, and these tests must not start reading it.
  const config = loadConfig({
    WATCHLIST: 'AAPL',
    EVIDENCE_FILE: '/nonexistent/evidence.json',
    ...env,
  });
  const agent = new TradingAgent({ config, clock, stack: emptyStack() });
  return { agent, config };
}

async function request(
  env: Record<string, string>,
  headers: Record<string, string> = {},
  path = '/',
): Promise<{ status: number; body: string; challenge?: string }> {
  const { agent, config } = agentFor(env);
  const server = createApiServer({ agent, config });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      const challenge = res.headers.get('www-authenticate') ?? undefined;
      resolve({
        status: res.status,
        body: await res.text(),
        ...(challenge ? { challenge } : {}),
      });
      server.close();
    });
  });
}

function basic(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

describe('dashboard exposure gate', () => {
  it('refuses a non-loopback bind without a password', () => {
    expect(() => assertExposureIsSafe('0.0.0.0', undefined)).toThrow(UnsafeExposureError);
  });

  it('names the SSH tunnel alternative rather than only refusing', () => {
    // A refusal that does not say what to do instead gets worked around.
    expect(() => assertExposureIsSafe('0.0.0.0', undefined)).toThrow(/ssh -N -L/);
  });

  it('allows a non-loopback bind once a password is set', () => {
    expect(() => assertExposureIsSafe('0.0.0.0', PASSWORD)).not.toThrow();
  });

  it('allows loopback with no password at all', () => {
    expect(() => assertExposureIsSafe('127.0.0.1', undefined)).not.toThrow();
  });

  it('fails the whole boot, not just the server, on an unsafe combination', () => {
    // Refusing at config load means no cycle runs and no state is written
    // before the mistake surfaces.
    expect(() => loadConfig({ DASHBOARD_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('rejects a password short enough to brute force', () => {
    expect(() => loadConfig({ DASHBOARD_HOST: '0.0.0.0', DASHBOARD_PASSWORD: 'short' })).toThrow(
      ConfigError,
    );
  });
});

/**
 * The exposure a bind address cannot see.
 *
 * `assertExposureIsSafe` runs once, against the host the socket listens on. A
 * tunnel leaves that answer at 127.0.0.1 and puts the dashboard on the public
 * internet anyway, so the startup gate passes and the portfolio is served to
 * whoever has the URL. These tests pin the second gate, which asks the same
 * question per request.
 */
describe('recognising a request that arrived from outside', () => {
  it('sees a tunnel by the forwarding header it adds', () => {
    expect(looksPubliclyRouted({ 'x-forwarded-for': '203.0.113.9' })).toBe(true);
    expect(looksPubliclyRouted({ forwarded: 'for=203.0.113.9' })).toBe(true);
    expect(looksPubliclyRouted({ 'x-forwarded-host': 'agent.example.com' })).toBe(true);
  });

  it('sees a public hostname even with no forwarding header', () => {
    expect(looksPubliclyRouted({ host: 'abc-def.trycloudflare.com' })).toBe(true);
    expect(looksPubliclyRouted({ host: '203.0.113.9:3000' })).toBe(true);
  });

  it('leaves a local browser and an SSH forward alone', () => {
    // ssh -L makes the browser ask for localhost, which is the recommended
    // path and must not start being refused.
    for (const host of ['127.0.0.1:3000', 'localhost:3000', 'localhost', '[::1]:3000']) {
      expect(looksPubliclyRouted({ host }), `${host} was called public`).toBe(false);
    }
  });

  it('draws no conclusion from a request with no Host at all', () => {
    expect(looksPubliclyRouted({})).toBe(false);
  });
});

describe('serving a passwordless dashboard through a tunnel', () => {
  it('refuses, and says which variable fixes it', async () => {
    const response = await request({}, { 'x-forwarded-for': '203.0.113.9' });
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/DASHBOARD_PASSWORD/);
  });

  it('leaks no portfolio data in the refusal', async () => {
    const response = await request({}, { 'x-forwarded-for': '203.0.113.9' });
    expect(response.body).not.toContain('10000');
    expect(response.body).not.toContain('AI Market Agent');
  });

  it('refuses the JSON API too, not only the page', async () => {
    for (const path of ['/api/state', '/api/portfolio', '/api/diagnostic']) {
      const response = await request({}, { 'x-forwarded-for': '203.0.113.9' }, path);
      expect(response.status, `${path} was served`).toBe(403);
    }
  });

  it('serves it once a password is set — the tunnel is not the problem', async () => {
    // The gate exists to require a password, not to ban tunnels. With one set,
    // the ordinary Basic challenge takes over.
    const response = await request(
      { DASHBOARD_PASSWORD: PASSWORD },
      { ...basic('admin', PASSWORD), 'x-forwarded-for': '203.0.113.9' },
    );
    expect(response.status).toBe(200);
  });

  it('still challenges an anonymous request through the tunnel', async () => {
    const response = await request(
      { DASHBOARD_PASSWORD: PASSWORD },
      { 'x-forwarded-for': '203.0.113.9' },
    );
    expect(response.status).toBe(401);
  });
});

describe('dashboard authentication', () => {
  it('serves the page unauthenticated when no password is configured', async () => {
    const response = await request({});
    expect(response.status).toBe(200);
    expect(response.body).toContain('AI Market Agent');
  });

  it('challenges an anonymous request once a password is set', async () => {
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD });
    expect(response.status).toBe(401);
    expect(response.challenge).toMatch(/^Basic realm=/);
  });

  it('leaks no portfolio data in the challenge body', async () => {
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD });
    expect(response.body).not.toContain('10000');
    expect(response.body).not.toContain('Portfolio');
  });

  it('accepts the right credentials', async () => {
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD }, basic('admin', PASSWORD));
    expect(response.status).toBe(200);
    expect(response.body).toContain('AI Market Agent');
  });

  it('rejects the right user with the wrong password', async () => {
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD }, basic('admin', 'wrong-password'));
    expect(response.status).toBe(401);
  });

  it('rejects the right password under the wrong user', async () => {
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD }, basic('root', PASSWORD));
    expect(response.status).toBe(401);
  });

  it('honours a custom user name', async () => {
    const response = await request(
      { DASHBOARD_PASSWORD: PASSWORD, DASHBOARD_USER: 'matpo' },
      basic('matpo', PASSWORD),
    );
    expect(response.status).toBe(200);
  });

  it('protects the JSON API, not only the HTML page', async () => {
    // The API is where the machine-readable portfolio lives; protecting only
    // the page would be theatre.
    for (const path of ['/api/state', '/api/portfolio', '/api/orders', '/api/health']) {
      const response = await request({ DASHBOARD_PASSWORD: PASSWORD }, {}, path);
      expect(response.status, `${path} was unprotected`).toBe(401);
    }
  });

  it('does not reveal which paths exist before authenticating', async () => {
    // A 404 for unknown paths and a 401 for real ones would map the surface.
    const response = await request({ DASHBOARD_PASSWORD: PASSWORD }, {}, '/api/does-not-exist');
    expect(response.status).toBe(401);
  });

  it('still exposes no endpoint that could place an order', async () => {
    const response = await request(
      { DASHBOARD_PASSWORD: PASSWORD },
      basic('admin', PASSWORD),
      '/api/order',
    );
    expect(response.status).toBe(404);
  });
});

describe('settings panel', () => {
  it('never puts a credential in the settings, only whether things are on', async () => {
    // The health panel already says whether a key is present. The key itself
    // has no reason to reach a browser.
    const response = await request(
      { DASHBOARD_PASSWORD: PASSWORD, ANTHROPIC_API_KEY: 'sk-ant-panel-secret', LLM_PROVIDER: 'anthropic' },
      basic('admin', PASSWORD),
      '/api/settings',
    );
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('sk-ant-panel-secret');
    expect(response.body).toContain('claude-opus-5');
  });

  it('shows the risk limits that actually gate trading', async () => {
    const response = await request({}, {}, '/api/settings');
    for (const label of ['Daily loss limit', 'Risk per trade', 'Quote staleness', 'Max position']) {
      expect(response.body, `${label} missing`).toContain(label);
    }
  });

  it('says plainly when no study has been run rather than showing an empty table', async () => {
    // An empty evidence panel and a panel saying "nothing is blocked" mean very
    // different things, and the second one is the truth.
    const response = await request({}, {}, '/');
    expect(response.body).toContain('No study has been run');
  });

  it('exposes no endpoint that could change a setting', async () => {
    // A dashboard that can retune risk limits is a dashboard that can remove
    // them. Settings are read-only, and editing means .env plus a restart.
    for (const path of ['/api/settings/update', '/api/config', '/api/settings/set']) {
      const response = await request({}, {}, path);
      expect(response.status, path).toBe(404);
    }
  });
});
