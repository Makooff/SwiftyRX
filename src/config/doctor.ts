import type { AppConfig } from './env.js';

/**
 * Setup diagnosis.
 *
 * `check-config` answers "what is configured?". This answers the question an
 * operator actually has: **what works, what does not, and exactly what to do
 * about it.**
 *
 * The distinction that shapes this file: a missing credential is not an error.
 * The system is designed to run with none, and degrade honestly. But "degrades
 * honestly" is only useful if the operator knows *which* capability they lost —
 * otherwise a quiet run with no signals looks identical to a broken one.
 *
 * Every remedy names a concrete next step and, where one exists, the URL that
 * issues the credential. Telling someone a key is missing without telling them
 * where to get it is half an answer.
 */

export type CheckStatus =
  /** Working. */
  | 'ok'
  /** Nothing can trade until this is fixed. */
  | 'blocking'
  /** Runs, but a capability is unavailable. */
  | 'degraded'
  /** Deliberately off; no action needed. */
  | 'off';

export interface Diagnostic {
  id: string;
  label: string;
  status: CheckStatus;
  /** The consequence, in terms of what the system can or cannot do. */
  impact: string;
  /** Concrete next step. Absent when there is nothing to do. */
  remedy?: string;
  /** Where to obtain the credential, when applicable. */
  url?: string;
}

const MARKET_DATA_URL = 'https://app.alpaca.markets/paper/dashboard/overview';
const ANTHROPIC_URL = 'https://console.anthropic.com/settings/keys';
const FRED_URL = 'https://fredaccount.stlouisfed.org/apikeys';
const SEC_URL = 'https://www.sec.gov/os/webmaster-faq#developers';

function marketData(config: AppConfig): Diagnostic {
  const providers: string[] = [];
  if (config.ALPACA_API_KEY_ID && config.ALPACA_API_SECRET_KEY) providers.push('Alpaca');
  if (config.FINNHUB_API_KEY) providers.push('Finnhub');
  if (config.ALPHA_VANTAGE_API_KEY) providers.push('Alpha Vantage');

  if (providers.length === 0) {
    return {
      id: 'market_data',
      label: 'Market data',
      // Blocking, not degraded: without a price there is no quote, and without
      // a quote the freshness rule refuses every order. Nothing downstream can
      // run, however well configured it is.
      status: 'blocking',
      impact: 'No price source. Every order is refused as unpriceable — nothing can trade.',
      remedy:
        'Create a free Alpaca account and set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. ' +
        'Paper keys are enough and are available worldwide.',
      url: MARKET_DATA_URL,
    };
  }

  return {
    id: 'market_data',
    label: 'Market data',
    status: 'ok',
    impact: `Prices from ${providers.join(', ')}.${
      providers.includes('Alpaca')
        ? ' Alpaca free tier is IEX-only — one venue, not the consolidated tape.'
        : ''
    }`,
  };
}

function llm(config: AppConfig): Diagnostic {
  if (config.LLM_PROVIDER === 'none' || !config.ANTHROPIC_API_KEY) {
    return {
      id: 'llm',
      label: 'Event analysis (Claude)',
      status: 'degraded',
      impact:
        'Events are ingested, detected and verified, but no signals are produced and no orders are placed.',
      remedy: 'Set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic. Set a spending limit in Billing while you are there.',
      url: ANTHROPIC_URL,
    };
  }
  return {
    id: 'llm',
    label: 'Event analysis (Claude)',
    status: 'ok',
    impact: `Using ${config.LLM_MODEL}. One call per detected event, not per document.`,
  };
}

function secContact(config: AppConfig): Diagnostic {
  if (!config.CONTACT_EMAIL) {
    return {
      id: 'sec_contact',
      label: 'SEC EDGAR access',
      status: 'degraded',
      impact:
        'SEC filings are disabled. That is the highest-reliability source in the system, and the one that makes an event officially confirmed.',
      remedy:
        'Set CONTACT_EMAIL to a real address. The SEC requires it in the User-Agent and returns 403 without it; the adapter refuses to send a request rather than risk your IP being blocked.',
      url: SEC_URL,
    };
  }
  return {
    id: 'sec_contact',
    label: 'SEC EDGAR access',
    status: 'ok',
    impact: `Requests identify as "${config.userAgent}". No key needed; SEC data is public domain.`,
  };
}

function macro(config: AppConfig): Diagnostic {
  if (!config.FRED_API_KEY) {
    return {
      id: 'macro',
      label: 'US macro (FRED)',
      status: 'degraded',
      impact:
        'No US macro context in scoring. ECB data still works — it needs no key.',
      remedy: 'Optional. Set FRED_API_KEY for point-in-time macro series, which backtests need to avoid look-ahead.',
      url: FRED_URL,
    };
  }
  return {
    id: 'macro',
    label: 'US macro (FRED)',
    status: 'ok',
    impact: 'Vintage-aware series available, so backtests can read the number published on the decision date.',
  };
}

function watchlist(config: AppConfig): Diagnostic {
  if (config.WATCHLIST.length === 0) {
    return {
      id: 'watchlist',
      label: 'Watchlist',
      status: 'blocking',
      impact: 'No instruments are followed, so no event can be attributed to an asset.',
      remedy: 'Set WATCHLIST, e.g. WATCHLIST=AAPL,MSFT,NVDA.',
    };
  }
  return {
    id: 'watchlist',
    label: 'Watchlist',
    status: 'ok',
    impact: `Following ${config.WATCHLIST.join(', ')}.`,
  };
}

function tradingMode(config: AppConfig): Diagnostic {
  if (!config.isLive) {
    return {
      id: 'mode',
      label: 'Trading mode',
      status: 'ok',
      impact: `Mode "${config.MODE}". No real money can be traded, whatever else is misconfigured.`,
    };
  }

  return {
    id: 'mode',
    label: 'Trading mode',
    // Not an error — the operator asked for it explicitly and the config
    // loader already enforced every precondition. But it is never "ok" in the
    // sense of "nothing to think about".
    status: 'degraded',
    impact: `LIVE. Real money at risk, up to ${config.LIVE_CAPITAL_EUR} ${config.BASE_CURRENCY}, on ${config.ALLOWED_ASSETS.join(', ')}.`,
    remedy:
      'Confirm you have: run the adapter against paper-api.alpaca.markets, backtested on real market data, and checked Alpaca live eligibility for your jurisdiction. Having the code is not evidence that any of these happened.',
  };
}

function social(config: AppConfig): Diagnostic {
  if (!config.ENABLE_X_INGESTION) {
    return {
      id: 'social',
      label: 'X ingestion',
      status: 'off',
      impact: 'Disabled. X reads are billed per post and can never trigger an order on their own.',
    };
  }
  return {
    id: 'social',
    label: 'X ingestion',
    status: 'degraded',
    impact: `Enabled, budget ${config.X_MAX_POSTS_READ_PER_DAY} posts/day. The budget is per process and in memory: two instances spend twice.`,
    remedy: 'Set a spending cap in the X developer console too. Do not rely on this code alone to protect your card.',
  };
}

function discord(config: AppConfig): Diagnostic {
  if (config.REQUIRE_APPROVAL) {
    return {
      id: 'discord',
      label: 'Discord',
      // Not "ok": every order now waits on a human, and an unanswered
      // question is a refused trade. That is worth seeing on the status page.
      status: 'degraded',
      impact: `Notifications on. Every order needs a ✅ within ${config.APPROVAL_TIMEOUT_SECONDS}s or it is refused.`,
      remedy:
        'In paper mode this measures you rather than the strategy. Turn REQUIRE_APPROVAL off while collecting a track record.',
    };
  }
  if (!config.DISCORD_WEBHOOK_URL) {
    return {
      id: 'discord',
      label: 'Discord',
      status: 'off',
      impact: 'No notifications. The dashboard and the decision journal still record everything.',
    };
  }
  return {
    id: 'discord',
    label: 'Discord',
    status: 'ok',
    impact: 'Notifications on: signals, orders, halts and a daily summary. Approval is off.',
  };
}

export function diagnose(config: AppConfig): Diagnostic[] {
  return [
    tradingMode(config),
    marketData(config),
    watchlist(config),
    llm(config),
    secContact(config),
    macro(config),
    discord(config),
    social(config),
  ];
}

export interface DoctorSummary {
  /** `trading` needs prices and signals; `observing` detects events but cannot act. */
  readiness: 'trading' | 'observing' | 'blocked';
  blocking: Diagnostic[];
  degraded: Diagnostic[];
  headline: string;
}

export function summarise(diagnostics: Diagnostic[]): DoctorSummary {
  const blocking = diagnostics.filter((d) => d.status === 'blocking');
  const degraded = diagnostics.filter((d) => d.status === 'degraded');

  if (blocking.length > 0) {
    return {
      readiness: 'blocked',
      blocking,
      degraded,
      headline: `${blocking.length} blocking issue(s): the system cannot place an order until they are fixed.`,
    };
  }

  // Signals need the model. Without it the pipeline still does real work —
  // ingest, detect, verify — it simply never proposes a trade.
  const noLlm = diagnostics.some((d) => d.id === 'llm' && d.status === 'degraded');
  if (noLlm) {
    return {
      readiness: 'observing',
      blocking,
      degraded,
      headline: 'Ready to observe: events are detected and verified, but no signals are generated.',
    };
  }

  return {
    readiness: 'trading',
    blocking,
    degraded,
    headline: 'Ready: the full loop can run. Verify the sources actually respond before trusting it.',
  };
}
