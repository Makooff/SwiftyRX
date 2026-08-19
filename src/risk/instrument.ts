/**
 * What kind of instrument is this symbol, and are we allowed to trade it?
 *
 * `.env.example` promises that crypto, options, derivatives and margin are all
 * off by default. Until this file existed that promise was decorative:
 * ALLOW_CRYPTO and its siblings were parsed, cross-validated against each other,
 * printed by `npm run config:check` — and read by no code path that could refuse
 * an order. A watchlist entry of `DOGE/USD` would have been sized, risk-checked
 * and filled with ALLOW_CRYPTO=false, and nothing would have said otherwise.
 *
 * The direction of the guarantee matters. This classifier does NOT try to prove
 * a symbol is an equity — that is unprovable from a string. It positively
 * identifies the *restricted* shapes and refuses them unless their flag is on.
 * A venue using a convention not listed here would be classified `equity` and
 * pass, so this is a floor and not a ceiling: for real money, ALLOWED_ASSETS
 * remains the hard control, because it is an allowlist rather than a pattern.
 */

export type InstrumentClass = 'equity' | 'crypto' | 'option';

/**
 * Quote currencies that make a pair a crypto pair rather than a ticker.
 *
 * Deliberately short. `BTC/USD` is unambiguous; a bare `BTC` is not — it is
 * also a listed equity ticker on several exchanges, and guessing would refuse
 * legitimate orders. The separator is what carries the meaning.
 */
const CRYPTO_QUOTES = new Set(['USD', 'USDT', 'USDC', 'EUR', 'BTC', 'ETH', 'SOL', 'DAI']);

/**
 * Occidental-convention option symbol: root, 6-digit expiry, C or P, 8-digit
 * strike — e.g. AAPL260116C00150000. Nothing else in this system produces a
 * 15+ character symbol ending in eight digits.
 */
const OCC_OPTION = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

/**
 * Pair notation: BTC/USD, BTC-USD, BTC_USD. Not BTCUSD — concatenation cannot
 * be told apart from a ticker without a venue list, and a wrong guess here
 * refuses real equity orders.
 */
const PAIR = /^([A-Z0-9]{2,15})[/\-_]([A-Z]{3,5})$/;

export function classifyInstrument(symbol: string): InstrumentClass {
  const upper = symbol.trim().toUpperCase();

  if (OCC_OPTION.test(upper)) return 'option';

  const pair = PAIR.exec(upper);
  if (pair && CRYPTO_QUOTES.has(pair[2]!)) return 'crypto';

  return 'equity';
}

export interface InstrumentPermissions {
  ALLOW_CRYPTO: boolean;
  ALLOW_OPTIONS: boolean;
  ALLOW_DERIVATIVES: boolean;
}

export interface InstrumentVerdict {
  permitted: boolean;
  instrument: InstrumentClass;
  detail: string;
}

/**
 * The gate itself.
 *
 * Options need both flags on purpose: an option is a derivative, so
 * ALLOW_OPTIONS alone would let one class of derivative through a switch that
 * claims to govern all of them. `loadConfig` already refuses that combination
 * at startup; this repeats it at the order boundary, for the same reason live
 * trading is checked twice — one check is one mistake away.
 */
export function instrumentVerdict(
  symbol: string,
  permissions: InstrumentPermissions,
): InstrumentVerdict {
  const instrument = classifyInstrument(symbol);

  if (instrument === 'crypto' && !permissions.ALLOW_CRYPTO) {
    return {
      permitted: false,
      instrument,
      detail: `${symbol} is a crypto pair and ALLOW_CRYPTO is false`,
    };
  }

  if (instrument === 'option') {
    if (!permissions.ALLOW_OPTIONS) {
      return {
        permitted: false,
        instrument,
        detail: `${symbol} is an option contract and ALLOW_OPTIONS is false`,
      };
    }
    if (!permissions.ALLOW_DERIVATIVES) {
      return {
        permitted: false,
        instrument,
        detail: `${symbol} is an option contract and ALLOW_DERIVATIVES is false`,
      };
    }
  }

  return { permitted: true, instrument, detail: `${symbol} is ${instrument}, permitted` };
}
