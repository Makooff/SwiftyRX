import { describe, expect, it } from 'vitest';
import { classifyInstrument, instrumentVerdict } from '../src/risk/instrument.js';

/**
 * Instrument permissions.
 *
 * `.env.example` promises crypto, options and derivatives are off by default.
 * Before this gate existed the flags were parsed and printed and read by
 * nothing — a `DOGE/USD` in the watchlist would have been sized, risk-checked
 * and filled with ALLOW_CRYPTO=false.
 *
 * The property under test is asymmetric on purpose: refusing a real equity is
 * an annoyance, letting a forbidden instrument through is the failure this
 * exists to prevent. So the equity cases are tested as hard as the crypto ones.
 */

const OFF = { ALLOW_CRYPTO: false, ALLOW_OPTIONS: false, ALLOW_DERIVATIVES: false };

describe('telling one kind of symbol from another', () => {
  it('reads an explicit crypto pair as crypto', () => {
    for (const symbol of ['BTC/USD', 'DOGE-USD', 'SHIB_USDT', 'PEPE/USDC', 'BONK/SOL']) {
      expect(classifyInstrument(symbol), symbol).toBe('crypto');
    }
  });

  it('reads an OCC option symbol as an option', () => {
    expect(classifyInstrument('AAPL260116C00150000')).toBe('option');
    expect(classifyInstrument('SPY260320P00400000')).toBe('option');
  });

  it('leaves an ordinary ticker alone', () => {
    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'BRK.B', 'SPY']) {
      expect(classifyInstrument(symbol), symbol).toBe('equity');
    }
  });

  it('does not read a bare three-letter ticker as crypto', () => {
    // BTC without a quote currency is also a listed equity ticker. Guessing
    // here would refuse legitimate orders, so the separator carries the
    // meaning and a bare symbol never does.
    expect(classifyInstrument('BTC')).toBe('equity');
    expect(classifyInstrument('ETH')).toBe('equity');
  });

  it('does not read a concatenated pair as crypto', () => {
    // BTCUSD cannot be told from a ticker without a venue list. Documented as
    // a known gap rather than guessed at: for real money ALLOWED_ASSETS is the
    // control, because it is an allowlist and not a pattern.
    expect(classifyInstrument('BTCUSD')).toBe('equity');
  });

  it('ignores case and surrounding space', () => {
    expect(classifyInstrument(' doge/usd ')).toBe('crypto');
  });
});

describe('deciding whether an instrument may be traded', () => {
  it('refuses a crypto pair while ALLOW_CRYPTO is false', () => {
    const verdict = instrumentVerdict('DOGE/USD', OFF);
    expect(verdict.permitted).toBe(false);
    expect(verdict.detail).toMatch(/ALLOW_CRYPTO is false/);
  });

  it('names the variable to set rather than only refusing', () => {
    // A refusal that does not say what to change gets worked around.
    expect(instrumentVerdict('PEPE/USD', OFF).detail).toContain('ALLOW_CRYPTO');
  });

  it('permits it once ALLOW_CRYPTO is on', () => {
    expect(instrumentVerdict('DOGE/USD', { ...OFF, ALLOW_CRYPTO: true }).permitted).toBe(true);
  });

  it('refuses an option even when options alone are allowed', () => {
    // An option is a derivative. Letting ALLOW_OPTIONS alone through would open
    // one class of derivative via a switch that claims to govern all of them.
    const verdict = instrumentVerdict('AAPL260116C00150000', { ...OFF, ALLOW_OPTIONS: true });
    expect(verdict.permitted).toBe(false);
    expect(verdict.detail).toMatch(/ALLOW_DERIVATIVES is false/);
  });

  it('permits an option only with both flags on', () => {
    const verdict = instrumentVerdict('AAPL260116C00150000', {
      ALLOW_CRYPTO: false,
      ALLOW_OPTIONS: true,
      ALLOW_DERIVATIVES: true,
    });
    expect(verdict.permitted).toBe(true);
  });

  it('leaves equities untouched by any of these flags', () => {
    // The default configuration must trade equities exactly as it did before
    // this gate existed, or it would be a regression dressed as a safety fix.
    for (const symbol of ['AAPL', 'MSFT', 'BRK.B']) {
      expect(instrumentVerdict(symbol, OFF).permitted, symbol).toBe(true);
    }
  });
});
