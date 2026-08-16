import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Two rules govern this file:
 *  1. Defaults are always the safe option. A completely empty `.env` must
 *     produce a system that cannot touch real money.
 *  2. Unsafe combinations fail at startup, not at order time.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

export const TradingMode = z.enum(['backtest', 'paper', 'live']);
export type TradingMode = z.infer<typeof TradingMode>;

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: bool(true),

  // ---- Trading mode -------------------------------------------------------
  MODE: TradingMode.default('paper'),
  PAPER_TRADING: bool(true),
  LIVE_TRADING: bool(false),
  /** Must equal LIVE_CONFIRMATION_PHRASE for live mode to boot. */
  LIVE_TRADING_CONFIRMATION: z.string().optional(),

  // ---- Instrument permissions (all off by default) ------------------------
  ALLOWED_ASSETS: csv([]),
  ALLOW_CRYPTO: bool(false),
  ALLOW_OPTIONS: bool(false),
  ALLOW_DERIVATIVES: bool(false),
  ALLOW_MARGIN: bool(false),
  ALLOW_SHORT_SELLING: bool(false),
  MAX_LEVERAGE: num(1),

  // ---- Capital ------------------------------------------------------------
  /**
   * Paper and backtest portfolio size. Deliberately larger than the live
   * target: at a few hundred euros, position sizes are swamped by commission
   * and spread, so paper results measure costs rather than signal quality.
   * See docs/SPEC_ADAPTATIONS.md §6.
   */
  PAPER_CAPITAL_EUR: num(10_000),
  /** Real money actually at risk if live trading is ever enabled. */
  LIVE_CAPITAL_EUR: num(300),
  BASE_CURRENCY: z.string().default('EUR'),

  // ---- Risk limits (consumed by the Risk Engine in Phase 4) ---------------
  MAX_POSITION_PERCENT: num(20),
  MAX_DAILY_LOSS_PERCENT: num(2),
  MAX_PORTFOLIO_EXPOSURE_PERCENT: num(80),
  MAX_TRADES_PER_DAY: num(10),
  MAX_SINGLE_TRADE_RISK_PERCENT: num(1),
  MAX_CORRELATED_EXPOSURE_PERCENT: num(35),
  CONSECUTIVE_LOSS_COOLDOWN_MINUTES: num(120),
  /** Market data older than this is treated as unusable -> DO NOT TRADE. */
  MAX_QUOTE_STALENESS_SECONDS: num(120),

  // ---- Infrastructure -----------------------------------------------------
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  HTTP_TIMEOUT_MS: num(10_000),
  HTTP_MAX_RETRIES: num(3),

  /**
   * SEC requires a descriptive User-Agent with a contact address on every
   * request. Without it EDGAR returns 403.
   */
  CONTACT_EMAIL: z.string().optional(),
  USER_AGENT_APP_NAME: z.string().default('ai-market-agent'),

  // ---- Data provider credentials (all optional) ---------------------------
  ALPACA_API_KEY_ID: z.string().optional(),
  ALPACA_API_SECRET_KEY: z.string().optional(),
  ALPACA_DATA_FEED: z.enum(['iex', 'sip']).default('iex'),
  FINNHUB_API_KEY: z.string().optional(),
  ALPHA_VANTAGE_API_KEY: z.string().optional(),
  FRED_API_KEY: z.string().optional(),

  // ---- Social (opt-in, metered, off by default) ---------------------------
  ENABLE_X_INGESTION: bool(false),
  X_BEARER_TOKEN: z.string().optional(),
  /** Hard stop on metered X reads per day. 0 disables reads entirely. */
  X_MAX_POSTS_READ_PER_DAY: num(0),
  X_WATCHED_ACCOUNTS: csv([]),

  // ---- LLM (wired in Phase 3) ---------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  LLM_MODEL: z.string().default('claude-sonnet-4-5'),

  // ---- Ingestion ----------------------------------------------------------
  WATCHLIST: csv(['AAPL', 'MSFT', 'NVDA']),
  INGEST_INTERVAL_SECONDS: num(60),
  ENABLED_SOURCES: csv([]),
});

export const LIVE_CONFIRMATION_PHRASE = 'I_UNDERSTAND_REAL_MONEY_RISK';

export type AppConfig = z.infer<typeof rawSchema> & {
  isLive: boolean;
  isPaper: boolean;
  isBacktest: boolean;
  /** Starting capital for the active mode: live uses real money, others do not. */
  initialCapital: number;
  userAgent: string;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Safety invariants checked after schema parsing.
 *
 * These exist so that reaching live trading requires a deliberate, explicit
 * act. Nothing here should ever be relaxed to "make it work".
 */
function assertSafetyInvariants(cfg: z.infer<typeof rawSchema>): string[] {
  const problems: string[] = [];

  if (cfg.MODE === 'live') {
    if (!cfg.LIVE_TRADING) {
      problems.push('MODE=live requires LIVE_TRADING=true (it is false).');
    }
    if (cfg.PAPER_TRADING) {
      problems.push('MODE=live requires PAPER_TRADING=false.');
    }
    if (cfg.LIVE_TRADING_CONFIRMATION !== LIVE_CONFIRMATION_PHRASE) {
      problems.push(`MODE=live requires LIVE_TRADING_CONFIRMATION="${LIVE_CONFIRMATION_PHRASE}".`);
    }
    if (cfg.ALLOWED_ASSETS.length === 0) {
      problems.push('MODE=live requires a non-empty ALLOWED_ASSETS allowlist.');
    }
    if (cfg.MAX_DAILY_LOSS_PERCENT <= 0 || cfg.MAX_DAILY_LOSS_PERCENT > 10) {
      problems.push('MODE=live requires 0 < MAX_DAILY_LOSS_PERCENT <= 10.');
    }
    if (cfg.MAX_POSITION_PERCENT <= 0 || cfg.MAX_POSITION_PERCENT > 100) {
      problems.push('MODE=live requires 0 < MAX_POSITION_PERCENT <= 100.');
    }
    if (cfg.MAX_SINGLE_TRADE_RISK_PERCENT <= 0 || cfg.MAX_SINGLE_TRADE_RISK_PERCENT > 5) {
      problems.push('MODE=live requires 0 < MAX_SINGLE_TRADE_RISK_PERCENT <= 5.');
    }
    if (cfg.MAX_TRADES_PER_DAY <= 0) {
      problems.push('MODE=live requires MAX_TRADES_PER_DAY > 0.');
    }
  } else if (cfg.LIVE_TRADING) {
    problems.push(`LIVE_TRADING=true is only valid with MODE=live (MODE=${cfg.MODE}).`);
  }

  if (cfg.MAX_LEVERAGE < 1) {
    problems.push('MAX_LEVERAGE must be >= 1.');
  }
  if (cfg.MAX_LEVERAGE > 1 && !cfg.ALLOW_MARGIN) {
    problems.push('MAX_LEVERAGE > 1 requires ALLOW_MARGIN=true (explicit opt-in).');
  }
  if (cfg.ALLOW_OPTIONS && !cfg.ALLOW_DERIVATIVES) {
    problems.push('ALLOW_OPTIONS=true requires ALLOW_DERIVATIVES=true (explicit opt-in).');
  }
  if (cfg.PAPER_CAPITAL_EUR <= 0) {
    problems.push('PAPER_CAPITAL_EUR must be > 0.');
  }
  if (cfg.LIVE_CAPITAL_EUR <= 0) {
    problems.push('LIVE_CAPITAL_EUR must be > 0.');
  }
  if (cfg.MAX_QUOTE_STALENESS_SECONDS <= 0) {
    problems.push('MAX_QUOTE_STALENESS_SECONDS must be > 0.');
  }

  if (cfg.ENABLE_X_INGESTION) {
    if (!cfg.X_BEARER_TOKEN) {
      problems.push('ENABLE_X_INGESTION=true requires X_BEARER_TOKEN.');
    }
    if (cfg.X_WATCHED_ACCOUNTS.length === 0) {
      problems.push('ENABLE_X_INGESTION=true requires an explicit X_WATCHED_ACCOUNTS list.');
    }
    if (cfg.X_MAX_POSTS_READ_PER_DAY <= 0) {
      problems.push(
        'ENABLE_X_INGESTION=true requires X_MAX_POSTS_READ_PER_DAY > 0 (X reads are billed per post).',
      );
    }
  }

  return problems;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  const problems = assertSafetyInvariants(parsed.data);
  if (problems.length > 0) throw new ConfigError(problems);

  const cfg = parsed.data;
  const contact = cfg.CONTACT_EMAIL ?? 'unset-contact@example.invalid';

  return {
    ...cfg,
    isLive: cfg.MODE === 'live',
    isPaper: cfg.MODE === 'paper',
    isBacktest: cfg.MODE === 'backtest',
    initialCapital: cfg.MODE === 'live' ? cfg.LIVE_CAPITAL_EUR : cfg.PAPER_CAPITAL_EUR,
    // Format expected by SEC EDGAR: "App Name contact@domain".
    userAgent: `${cfg.USER_AGENT_APP_NAME} ${contact}`,
  };
}

let cached: AppConfig | undefined;

/** Process-wide config singleton. */
export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: drop the memoised config. */
export function resetConfigCache(): void {
  cached = undefined;
}
