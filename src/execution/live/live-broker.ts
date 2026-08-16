import type { AppConfig } from '../../config/env.js';
import type { BrokerAdapter } from '../broker/types.js';

/**
 * Live broker gate.
 *
 * There is no live broker implementation in this repository, and this file is
 * the reason a future one cannot be switched on casually. Any live adapter must
 * be constructed through `assertLiveTradingAllowed`, which throws unless every
 * safety condition holds.
 *
 * Phase 9 is not implemented. When it is, the implementation must:
 *  - expose only the six BrokerAdapter methods — no withdrawal, no transfer,
 *    no account management, whatever the vendor SDK offers;
 *  - reject any symbol outside ALLOWED_ASSETS at the adapter boundary, not
 *    only in the Risk Engine;
 *  - use API credentials provisioned with trading permission only;
 *  - carry an idempotency key on every order.
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
 * Placeholder factory. Deliberately throws.
 *
 * Returning a working live adapter from an unfinished, untested implementation
 * would be the single most dangerous thing this codebase could do.
 */
export function createLiveBroker(config: AppConfig): BrokerAdapter {
  assertLiveTradingAllowed(config);
  throw new Error(
    'No live broker is implemented. Phase 9 requires a validated adapter, confirmed broker ' +
      'eligibility for your jurisdiction, and evidence from paper trading that the strategy works.',
  );
}
