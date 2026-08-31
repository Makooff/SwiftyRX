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

  it('sizes the paper portfolio for measurement, not for the live target', () => {
    const config = loadConfig(empty);
    // Paper runs at a notional where costs do not dominate position sizes, so
    // paper results say something about signal quality.
    expect(config.PAPER_CAPITAL_EUR).toBe(10_000);
    expect(config.initialCapital).toBe(10_000);
    expect(config.BASE_CURRENCY).toBe('EUR');
  });

  it('keeps the live capital target at €300', () => {
    expect(loadConfig(empty).LIVE_CAPITAL_EUR).toBe(300);
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

  it('uses the live capital target, not the paper notional, in live mode', () => {
    // Getting this backwards would risk 10k of real money on a 300 euro plan.
    const config = loadConfig(envFor(liveEnv));
    expect(config.initialCapital).toBe(300);
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

describe('minimum signal score', () => {
  it('keeps the historical bar when nothing is configured', () => {
    expect(loadConfig(empty).MIN_SIGNAL_SCORE).toBe(0.55);
  });

  it('can be lowered so a paper run actually produces fills to measure', () => {
    expect(loadConfig(envFor({ MIN_SIGNAL_SCORE: '0.3' })).MIN_SIGNAL_SCORE).toBe(0.3);
  });

  it('rejects a bar outside [0,1], which is a typo rather than a loose setting', () => {
    // 55 instead of 0.55 would silently refuse every order ever scored.
    expect(() => loadConfig(envFor({ MIN_SIGNAL_SCORE: '55' }))).toThrow(ConfigError);
    expect(() => loadConfig(envFor({ MIN_SIGNAL_SCORE: '-0.1' }))).toThrow(ConfigError);
  });

  it('refuses to carry a loosened paper bar into live mode', () => {
    expect(() => loadConfig(envFor({ ...liveEnv, MIN_SIGNAL_SCORE: '0.3' }))).toThrow(ConfigError);
    expect(loadConfig(envFor({ ...liveEnv, MIN_SIGNAL_SCORE: '0.6' })).MIN_SIGNAL_SCORE).toBe(0.6);
  });
});

describe('tradable universe', () => {
  it('is the union of the watchlist and the live allowlist', () => {
    const config = loadConfig(envFor({ WATCHLIST: 'AAPL,MSFT', ALLOWED_ASSETS: 'MSFT,TSLA' }));
    expect(config.tradableUniverse.sort()).toEqual(['AAPL', 'MSFT', 'TSLA']);
  });

  it('normalises case, so a lowercase entry still matches a model pick', () => {
    expect(loadConfig(envFor({ WATCHLIST: 'aapl' })).tradableUniverse).toEqual(['AAPL']);
  });
});

describe('model-chosen asset', () => {
  it('is off by default: trading a proxy is an inference, not a named subject', () => {
    expect(loadConfig(empty).ALLOW_MODEL_CHOSEN_ASSET).toBe(false);
  });

  it('can be enabled explicitly', () => {
    expect(loadConfig(envFor({ ALLOW_MODEL_CHOSEN_ASSET: 'true' })).ALLOW_MODEL_CHOSEN_ASSET).toBe(true);
  });
});

describe('what reaches the model', () => {
  it('keeps both analysis floors where they have always been', () => {
    const config = loadConfig(empty);
    expect(config.MIN_EVENT_MATERIALITY).toBe(0.4);
    expect(config.MIN_EVENT_CONFIDENCE).toBe(0.5);
  });

  it('can be lowered so a well-classified contract is finally analysed', () => {
    // 0.396 is the materiality of a perfectly classified signed contract with
    // a ticker — under the default floor by four thousandths.
    const config = loadConfig(envFor({ MIN_EVENT_MATERIALITY: '0.35' }));
    expect(config.MIN_EVENT_MATERIALITY).toBe(0.35);
    expect(0.396).toBeGreaterThan(config.MIN_EVENT_MATERIALITY);
  });

  it('rejects a floor outside [0,1] rather than dropping every event', () => {
    expect(() => loadConfig(envFor({ MIN_EVENT_MATERIALITY: '40' }))).toThrow(ConfigError);
    expect(() => loadConfig(envFor({ MIN_EVENT_CONFIDENCE: '-1' }))).toThrow(ConfigError);
  });

  it('leaves the analysis effort to the provider unless asked', () => {
    // The parameter was wired to the API and never set: every analysis this
    // system has produced ran at the provider's default.
    expect(loadConfig(empty).LLM_EFFORT).toBe('default');
    expect(loadConfig(envFor({ LLM_EFFORT: 'high' })).LLM_EFFORT).toBe('high');
  });

  it('refuses an effort level the provider does not define', () => {
    expect(() => loadConfig(envFor({ LLM_EFFORT: 'maximum' }))).toThrow(ConfigError);
  });

  it('caps events analysed per cycle, and refuses a cap of zero', () => {
    expect(loadConfig(empty).MAX_EVENTS_ANALYSED_PER_CYCLE).toBe(5);
    expect(loadConfig(envFor({ MAX_EVENTS_ANALYSED_PER_CYCLE: '12' })).MAX_EVENTS_ANALYSED_PER_CYCLE).toBe(12);
    // Zero would silently analyse nothing while every other setting looked fine.
    expect(() => loadConfig(envFor({ MAX_EVENTS_ANALYSED_PER_CYCLE: '0' }))).toThrow(ConfigError);
  });
});
