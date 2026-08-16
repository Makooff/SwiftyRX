import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { diagnose, summarise, type Diagnostic } from '../src/config/doctor.js';

/**
 * Setup diagnosis.
 *
 * The property under test is that the diagnosis is *actionable and correctly
 * ranked* — not merely that it reports fields. A doctor that calls a missing
 * price feed "degraded" would send someone off to fix the wrong thing.
 */

const LIVE_ENV = {
  MODE: 'live',
  LIVE_TRADING: 'true',
  PAPER_TRADING: 'false',
  LIVE_TRADING_CONFIRMATION: 'I_UNDERSTAND_REAL_MONEY_RISK',
  ALLOWED_ASSETS: 'AAPL',
};

const FULL_ENV = {
  ALPACA_API_KEY_ID: 'key',
  ALPACA_API_SECRET_KEY: 'secret',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  LLM_PROVIDER: 'anthropic',
  CONTACT_EMAIL: 'ops@example.com',
  FRED_API_KEY: 'fred',
};

function byId(diagnostics: Diagnostic[], id: string): Diagnostic {
  const found = diagnostics.find((d) => d.id === id);
  if (!found) throw new Error(`no diagnostic "${id}"`);
  return found;
}

describe('doctor', () => {
  it('treats a missing price feed as blocking, not merely degraded', () => {
    // Without a quote the freshness rule refuses every order, so nothing
    // downstream can run. Ranking this alongside "no macro data" would be
    // actively misleading.
    const diagnostics = diagnose(loadConfig({}));
    expect(byId(diagnostics, 'market_data').status).toBe('blocking');
    expect(summarise(diagnostics).readiness).toBe('blocked');
  });

  it('treats a missing LLM as degraded, because detection still works', () => {
    const diagnostics = diagnose(loadConfig({ ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's' }));
    expect(byId(diagnostics, 'llm').status).toBe('degraded');
    expect(summarise(diagnostics).readiness).toBe('observing');
  });

  it('reports full readiness only when prices and signals are both available', () => {
    const summary = summarise(diagnose(loadConfig(FULL_ENV)));
    expect(summary.readiness).toBe('trading');
    expect(summary.blocking).toHaveLength(0);
  });

  it('gives every problem a remedy, and a URL where a credential is needed', () => {
    const diagnostics = diagnose(loadConfig({}));
    for (const check of diagnostics) {
      if (check.status === 'blocking' || check.status === 'degraded') {
        expect(check.remedy, `${check.id} has no remedy`).toBeTruthy();
      }
    }
    // Naming a missing key without saying where to get it is half an answer.
    for (const id of ['market_data', 'llm', 'macro', 'sec_contact']) {
      expect(byId(diagnostics, id).url, `${id} has no URL`).toMatch(/^https:\/\//);
    }
  });

  it('never reports live mode as simply "ok"', () => {
    // Live is a state that always deserves a second thought, even when every
    // precondition the config loader checks has been met.
    const diagnostics = diagnose(loadConfig({ ...FULL_ENV, ...LIVE_ENV }));
    const mode = byId(diagnostics, 'mode');
    expect(mode.status).not.toBe('ok');
    expect(mode.impact).toContain('LIVE');
    expect(mode.remedy).toMatch(/paper-api|backtested/);
  });

  it('states plainly that paper mode cannot lose real money', () => {
    const mode = byId(diagnose(loadConfig(FULL_ENV)), 'mode');
    expect(mode.status).toBe('ok');
    expect(mode.impact).toMatch(/No real money/i);
  });

  it('reports X as off rather than as a problem to fix', () => {
    expect(byId(diagnose(loadConfig(FULL_ENV)), 'social').status).toBe('off');
  });

  it('warns that the X budget is per process once X is enabled', () => {
    const diagnostics = diagnose(
      loadConfig({
        ...FULL_ENV,
        ENABLE_X_INGESTION: 'true',
        X_BEARER_TOKEN: 'token',
        X_WATCHED_ACCOUNTS: '@sec_news',
        X_MAX_POSTS_READ_PER_DAY: '100',
      }),
    );
    expect(byId(diagnostics, 'social').impact).toMatch(/per process/);
  });

  it('flags an empty watchlist as blocking', () => {
    // Not reachable through `.env` — a blank WATCHLIST falls back to the
    // schema default, which is the right behaviour. The config object is built
    // directly here because that is the contract `diagnose` actually has.
    const diagnostics = diagnose({ ...loadConfig(FULL_ENV), WATCHLIST: [] });
    expect(byId(diagnostics, 'watchlist').status).toBe('blocking');
    expect(summarise(diagnostics).readiness).toBe('blocked');
  });

  it('never puts a credential value in its output', () => {
    const diagnostics = diagnose(loadConfig(FULL_ENV));
    const rendered = JSON.stringify(diagnostics);
    expect(rendered).not.toContain('sk-ant-test');
    expect(rendered).not.toContain('secret');
  });
});
