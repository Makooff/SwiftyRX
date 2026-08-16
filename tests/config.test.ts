import { describe, expect, it } from 'vitest';
import { ConfigError, LIVE_CONFIRMATION_PHRASE, loadConfig } from '../src/config/env.js';

/**
 * Configuration safety tests.
 *
 * These are the guardrails that stand between a bug and real money. They are
 * the first tests in the suite for that reason.
 */

const empty: NodeJS.ProcessEnv = {};

function envFor(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides };
}

const liveEnv = {
  MODE: 'live',
  LIVE_TRADING: 'true',
  PAPER_TRADING: 'false',
  LIVE_TRADING_CONFIRMATION: LIVE_CONFIRMATION_PHRASE,
  ALLOWED_ASSETS: 'AAPL,MSFT',
};

describe('default configuration', () => {
  it('defaults to paper trading with live disabled', () => {
    const config = loadConfig(empty);
    expect(config.MODE).toBe('paper');
    expect(config.PAPER_TRADING).toBe(true);
    expect(config.LIVE_TRADING).toBe(false);
    expect(config.isLive).toBe(false);
  });

  it('starts a €300 virtual portfolio', () => {
    const config = loadConfig(empty);
    expect(config.INITIAL_CAPITAL_EUR).toBe(300);
    expect(config.BASE_CURRENCY).toBe('EUR');
  });

  it('disables every risky instrument class by default', () => {
    const config = loadConfig(empty);
    expect(config.ALLOW_CRYPTO).toBe(false);
    expect(config.ALLOW_OPTIONS).toBe(false);
    expect(config.ALLOW_DERIVATIVES).toBe(false);
    expect(config.ALLOW_MARGIN).toBe(false);
    expect(config.ALLOW_SHORT_SELLING).toBe(false);
    expect(config.MAX_LEVERAGE).toBe(1);
  });

  it('starts with an empty live-trading allowlist', () => {
    expect(loadConfig(empty).ALLOWED_ASSETS).toEqual([]);
  });

  it('disables X ingestion and gives it a zero read budget', () => {
    const config = loadConfig(empty);
    expect(config.ENABLE_X_INGESTION).toBe(false);
    expect(config.X_MAX_POSTS_READ_PER_DAY).toBe(0);
  });
});

describe('live trading guards', () => {
  it('accepts a fully specified live configuration', () => {
    const config = loadConfig(envFor(liveEnv));
    expect(config.isLive).toBe(true);
  });

  it('rejects live mode without the confirmation phrase', () => {
    const env = envFor({ ...liveEnv });
    delete env.LIVE_TRADING_CONFIRMATION;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('rejects a confirmation phrase that is merely close', () => {
    expect(() =>
      loadConfig(envFor({ ...liveEnv, LIVE_TRADING_CONFIRMATION: 'i understand real money risk' })),
    ).toThrow(ConfigError);
  });

  it('rejects live mode while PAPER_TRADING is still true', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, PAPER_TRADING: 'true' }))).toThrow(ConfigError);
  });

  it('rejects live mode with an empty asset allowlist', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, ALLOWED_ASSETS: '' }))).toThrow(ConfigError);
  });

  it('rejects live mode with LIVE_TRADING=false', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, LIVE_TRADING: 'false' }))).toThrow(ConfigError);
  });

  it('rejects LIVE_TRADING=true outside live mode', () => {
    expect(() => loadConfig(envFor({ MODE: 'paper', LIVE_TRADING: 'true' }))).toThrow(ConfigError);
  });

  it('rejects an implausible daily loss limit in live mode', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, MAX_DAILY_LOSS_PERCENT: '50' }))).toThrow(ConfigError);
    expect(() => loadConfig(envFor({ ...liveEnv, MAX_DAILY_LOSS_PERCENT: '0' }))).toThrow(ConfigError);
  });

  it('rejects an excessive single-trade risk limit in live mode', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, MAX_SINGLE_TRADE_RISK_PERCENT: '25' }))).toThrow(
      ConfigError,
    );
  });
});

describe('instrument permission guards', () => {
  it('rejects leverage without an explicit margin opt-in', () => {
    expect(() => loadConfig(envFor({ MAX_LEVERAGE: '2' }))).toThrow(ConfigError);
  });

  it('allows leverage once margin is explicitly enabled', () => {
    const config = loadConfig(envFor({ MAX_LEVERAGE: '2', ALLOW_MARGIN: 'true' }));
    expect(config.MAX_LEVERAGE).toBe(2);
  });

  it('rejects options without a derivatives opt-in', () => {
    expect(() => loadConfig(envFor({ ALLOW_OPTIONS: 'true' }))).toThrow(ConfigError);
  });

  it('rejects leverage below 1', () => {
    expect(() => loadConfig(envFor({ MAX_LEVERAGE: '0.5' }))).toThrow(ConfigError);
  });
});

describe('X ingestion guards', () => {
  it('rejects enabling X without a token', () => {
    expect(() =>
      loadConfig(envFor({ ENABLE_X_INGESTION: 'true', X_WATCHED_ACCOUNTS: '@a', X_MAX_POSTS_READ_PER_DAY: '10' })),
    ).toThrow(ConfigError);
  });

  it('rejects enabling X without an explicit account list', () => {
    expect(() =>
      loadConfig(envFor({ ENABLE_X_INGESTION: 'true', X_BEARER_TOKEN: 'tok', X_MAX_POSTS_READ_PER_DAY: '10' })),
    ).toThrow(ConfigError);
  });

  it('rejects enabling X without a read budget, because reads are billed', () => {
    expect(() =>
      loadConfig(envFor({ ENABLE_X_INGESTION: 'true', X_BEARER_TOKEN: 'tok', X_WATCHED_ACCOUNTS: '@a' })),
    ).toThrow(ConfigError);
  });
});

describe('SEC user agent', () => {
  it('embeds the contact address the SEC requires', () => {
    const config = loadConfig(envFor({ CONTACT_EMAIL: 'ops@example.com' }));
    expect(config.userAgent).toBe('ai-market-agent ops@example.com');
  });
});
