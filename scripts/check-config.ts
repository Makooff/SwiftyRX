#!/usr/bin/env tsx
import { ConfigError, loadConfig } from '../src/config/env.js';
import { loadEnvFile } from '../src/config/load-env.js';

/**
 * Prints the effective configuration and the active safety posture.
 * Secrets are reported as present/absent, never printed.
 */

loadEnvFile();

try {
  const config = loadConfig();

  const secretPresence = (value: string | undefined) => (value ? 'set' : 'not set');

  console.log('\n=== AI Market Agent — configuration ===\n');
  console.log(`  mode                      ${config.MODE}`);
  console.log(`  paper trading             ${config.PAPER_TRADING}`);
  console.log(`  live trading              ${config.LIVE_TRADING}`);
  console.log(
    `  active capital            ${config.initialCapital} ${config.BASE_CURRENCY} (${config.MODE})`,
  );
  console.log(`  paper capital             ${config.PAPER_CAPITAL_EUR} ${config.BASE_CURRENCY}`);
  console.log(`  live capital target       ${config.LIVE_CAPITAL_EUR} ${config.BASE_CURRENCY}`);
  console.log(`  watchlist                 ${config.WATCHLIST.join(', ') || '(empty)'}`);
  console.log(`  allowed assets (live)     ${config.ALLOWED_ASSETS.join(', ') || '(empty)'}`);

  console.log('\n--- instrument permissions ---');
  console.log(`  crypto                    ${config.ALLOW_CRYPTO}`);
  console.log(`  options                   ${config.ALLOW_OPTIONS}`);
  console.log(`  derivatives               ${config.ALLOW_DERIVATIVES}`);
  console.log(`  margin                    ${config.ALLOW_MARGIN}`);
  console.log(`  short selling             ${config.ALLOW_SHORT_SELLING}`);
  console.log(`  max leverage              ${config.MAX_LEVERAGE}x`);

  console.log('\n--- risk limits ---');
  console.log(`  max position              ${config.MAX_POSITION_PERCENT}%`);
  console.log(`  max daily loss            ${config.MAX_DAILY_LOSS_PERCENT}%`);
  console.log(`  max portfolio exposure    ${config.MAX_PORTFOLIO_EXPOSURE_PERCENT}%`);
  console.log(`  max trades/day            ${config.MAX_TRADES_PER_DAY}`);
  console.log(`  max single trade risk     ${config.MAX_SINGLE_TRADE_RISK_PERCENT}%`);
  console.log(`  max correlated exposure   ${config.MAX_CORRELATED_EXPOSURE_PERCENT}%`);
  console.log(`  quote staleness limit     ${config.MAX_QUOTE_STALENESS_SECONDS}s`);

  console.log('\n--- credentials ---');
  console.log(`  CONTACT_EMAIL (SEC)       ${config.CONTACT_EMAIL ? config.CONTACT_EMAIL : 'not set'}`);
  console.log(`  ALPACA_API_KEY_ID         ${secretPresence(config.ALPACA_API_KEY_ID)}`);
  console.log(`  ALPACA_API_SECRET_KEY     ${secretPresence(config.ALPACA_API_SECRET_KEY)}`);
  console.log(`  FINNHUB_API_KEY           ${secretPresence(config.FINNHUB_API_KEY)}`);
  console.log(`  ALPHA_VANTAGE_API_KEY     ${secretPresence(config.ALPHA_VANTAGE_API_KEY)}`);
  console.log(`  FRED_API_KEY              ${secretPresence(config.FRED_API_KEY)}`);
  console.log(`  ANTHROPIC_API_KEY         ${secretPresence(config.ANTHROPIC_API_KEY)}`);
  console.log(`  X_BEARER_TOKEN            ${secretPresence(config.X_BEARER_TOKEN)}`);

  console.log('\n--- social ingestion ---');
  console.log(`  X ingestion enabled       ${config.ENABLE_X_INGESTION}`);
  console.log(`  X daily read budget       ${config.X_MAX_POSTS_READ_PER_DAY} posts`);
  console.log(`  X watched accounts        ${config.X_WATCHED_ACCOUNTS.join(', ') || '(none)'}`);

  if (config.isLive) {
    console.log('\n  !! LIVE TRADING IS ENABLED — real money is at risk !!\n');
  } else {
    console.log(`\n  No real money can be traded in mode "${config.MODE}".\n`);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error('\nConfiguration rejected:\n');
    for (const problem of err.problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }
  throw err;
}
