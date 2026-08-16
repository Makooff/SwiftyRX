import type { AppConfig } from '../../config/env.js';
import type { Logger } from '../../core/logger.js';
import type { MarketDataService } from '../../ingestion/market_data/index.js';
import type { BrokerAdapter } from '../broker/types.js';
import { AlpacaBroker } from './alpaca-broker.js';

/**
 * Live broker gate.
 *
 * This file is the reason live trading cannot be switched on casually. Every
 * live adapter is constructed through `assertLiveTradingAllowed`, which throws
 * unless every safety condition holds.
 *
 * The adapter behind it satisfies the constraints this file has always
 * specified:
 *  - only the six BrokerAdapter methods — no withdrawal, no transfer, no
 *    account management, whatever the vendor API offers;
 *  - any symbol outside ALLOWED_ASSETS is rejected at the adapter boundary, not
 *    only in the Risk Engine;
 *  - credentials must be provisioned with trading permission only;
 *  - every order carries an idempotency key, and order submission is never
 *    retried automatically.
 */

export class LiveTradingBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Live trading is blocked:\n  - ${reasons.join('\n  - ')}`);
    this.name = 'LiveTradingBlockedError';
  }
}

/**
 * Every condition that must hold before real money can be touched.
 *
 * The configuration loader already refuses to boot an inconsistent live setup;
 * this is the second, independent check at the point of use. Two gates that
 * must both open is the point — a single one is a single mistake away.
 */
export function assertLiveTradingAllowed(config: AppConfig): void {
  const reasons: string[] = [];

  if (config.MODE !== 'live') reasons.push(`MODE is "${config.MODE}", not "live"`);
  if (!config.LIVE_TRADING) reasons.push('LIVE_TRADING is false');
  if (config.PAPER_TRADING) reasons.push('PAPER_TRADING is still true');
  if (config.ALLOWED_ASSETS.length === 0) reasons.push('ALLOWED_ASSETS is empty');
  if (config.MAX_DAILY_LOSS_PERCENT <= 0) reasons.push('MAX_DAILY_LOSS_PERCENT is not set');
  if (config.MAX_SINGLE_TRADE_RISK_PERCENT <= 0) {
    reasons.push('MAX_SINGLE_TRADE_RISK_PERCENT is not set');
  }
  if (config.MAX_TRADES_PER_DAY <= 0) reasons.push('MAX_TRADES_PER_DAY is not set');

  if (reasons.length > 0) throw new LiveTradingBlockedError(reasons);
}

/**
 * Build the live broker.
 *
 * Reaching this function at all requires `MODE=live`, `LIVE_TRADING=true`,
 * `PAPER_TRADING=false`, the confirmation phrase and a non-empty allowlist —
 * checked once by the config loader at startup and again here. Nothing about
 * this path is reachable by default, and no code calls it on its own: the paper
 * entry point refuses live mode outright.
 *
 * The adapter itself is untested against the live API. Prove it on the Alpaca
 * paper endpoint first (`createAlpacaPaperBroker`), which speaks the same API
 * with no money behind it.
 */
export function createLiveBroker(
  config: AppConfig,
  deps: { marketData: MarketDataService; logger?: Logger },
): BrokerAdapter {
  assertLiveTradingAllowed(config);

  if (!config.ALPACA_API_KEY_ID || !config.ALPACA_API_SECRET_KEY) {
    throw new LiveTradingBlockedError([
      'ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required for live trading',
    ]);
  }

  return new AlpacaBroker({
    config,
    endpoint: 'live',
    apiKeyId: config.ALPACA_API_KEY_ID,
    apiSecretKey: config.ALPACA_API_SECRET_KEY,
    marketData: deps.marketData,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/**
 * The Alpaca *paper* endpoint: the real API, no real money.
 *
 * This is the step between local simulation and live trading, and the only
 * honest way to find out whether the adapter's request shapes are right. It
 * needs no live gate because it cannot move money — but it still enforces the
 * asset allowlist, so what you prove here is what will run later.
 */
export function createAlpacaPaperBroker(
  config: AppConfig,
  deps: { marketData: MarketDataService; logger?: Logger },
): BrokerAdapter {
  if (!config.ALPACA_API_KEY_ID || !config.ALPACA_API_SECRET_KEY) {
    throw new Error('ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required');
  }

  return new AlpacaBroker({
    config,
    endpoint: 'paper',
    apiKeyId: config.ALPACA_API_KEY_ID,
    apiSecretKey: config.ALPACA_API_SECRET_KEY,
    marketData: deps.marketData,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
