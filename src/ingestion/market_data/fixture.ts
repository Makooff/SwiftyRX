import { type Clock, systemClock } from '../../core/clock.js';
import type {
  AdapterKind,
  Bar,
  BarInterval,
  HealthReport,
  Quote,
  SourceDescriptor,
} from '../../domain/types.js';
import { describeSource, sourceRegistry } from '../source-registry.js';
import type { MarketDataSource } from '../types.js';

/**
 * Synthetic market data for offline development and tests.
 *
 * The numbers are a seeded random walk. They are NOT market data, and any
 * backtest run against this provider measures nothing about the real world —
 * `synthetic: true` is stamped on every bar so that stays impossible to miss.
 */

const INTERVAL_MS: Record<BarInterval, number> = {
  '1Min': 60_000,
  '5Min': 300_000,
  '15Min': 900_000,
  '1Hour': 3_600_000,
  '1Day': 86_400_000,
};

export const FIXTURE_SOURCE: SourceDescriptor = describeSource({
  id: 'fixture_market_data',
  name: 'Synthetic market data (development only)',
  tier: 'unknown',
  reliability: 0,
  authoritative: false,
  licenceNote: 'Generated locally. Not market data. Never use for evaluating a strategy.',
});

/** Deterministic PRNG so the same symbol always yields the same series. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function symbolSeed(symbol: string): number {
  let hash = 2_166_136_261;
  for (const char of symbol) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export interface FixtureMarketDataOptions {
  clock?: Clock;
  /** Starting price per symbol; defaults to a value derived from the symbol. */
  basePrices?: Record<string, number>;
  /** Per-step volatility as a fraction of price. */
  volatility?: number;
}

export class FixtureMarketDataAdapter implements MarketDataSource {
  readonly kind = 'market_data' as const;
  readonly id = 'fixture_market_data';
  readonly requiresCredentials = false;
  readonly sources = [FIXTURE_SOURCE];
  readonly delayNote = 'SYNTHETIC DATA — generated locally, unrelated to any real market.';

  private readonly clock: Clock;
  private readonly basePrices: Record<string, number>;
  private readonly volatility: number;

  constructor(options: FixtureMarketDataOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.basePrices = options.basePrices ?? {};
    this.volatility = options.volatility ?? 0.012;
    sourceRegistry.register(FIXTURE_SOURCE);
  }

  isConfigured(): boolean {
    return true;
  }

  private basePrice(symbol: string): number {
    return this.basePrices[symbol] ?? 20 + (symbolSeed(symbol) % 480);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const now = this.clock.now();
    const bars = await this.getBars(symbol, '1Min', {
      start: new Date(now.getTime() - 60_000 * 5),
      end: now,
    });
    const last = bars[bars.length - 1]?.close ?? this.basePrice(symbol);
    const spread = last * 0.0005;

    return {
      symbol,
      bid: Number((last - spread / 2).toFixed(4)),
      ask: Number((last + spread / 2).toFixed(4)),
      last: Number(last.toFixed(4)),
      currency: 'USD',
      freshness: {
        asOf: now.toISOString(),
        retrievedAt: now.toISOString(),
        delayClass: 'realtime',
        feed: 'fixture:synthetic',
      },
    };
  }

  async getBars(
    symbol: string,
    interval: BarInterval,
    options: { start: Date; end?: Date; limit?: number },
  ): Promise<Bar[]> {
    const step = INTERVAL_MS[interval];
    const end = options.end ?? this.clock.now();
    const retrievedAt = this.clock.now().toISOString();

    // Seed from the symbol *and* the first bucket so a given (symbol, time)
    // always produces the same bar, regardless of the query window.
    const startBucket = Math.floor(options.start.getTime() / step);
    const endBucket = Math.floor(end.getTime() / step);
    const random = seededRandom(symbolSeed(symbol) ^ startBucket);

    let price = this.basePrice(symbol);
    const bars: Bar[] = [];

    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const drift = (random() - 0.5) * 2 * this.volatility;
      const open = price;
      const close = Math.max(0.01, open * (1 + drift));
      const high = Math.max(open, close) * (1 + random() * this.volatility * 0.5);
      const low = Math.min(open, close) * (1 - random() * this.volatility * 0.5);
      price = close;

      const timestamp = new Date(bucket * step).toISOString();
      bars.push({
        symbol,
        timestamp,
        open: Number(open.toFixed(4)),
        high: Number(high.toFixed(4)),
        low: Number(low.toFixed(4)),
        close: Number(close.toFixed(4)),
        volume: Math.floor(100_000 + random() * 900_000),
        interval,
        freshness: {
          asOf: timestamp,
          retrievedAt,
          delayClass: 'realtime',
          feed: 'fixture:synthetic',
        },
      });
    }

    return options.limit ? bars.slice(-options.limit) : bars;
  }

  async health(): Promise<HealthReport> {
    return {
      adapter: this.id,
      kind: this.kind as AdapterKind,
      state: 'healthy',
      detail: 'synthetic provider — development use only',
      checkedAt: this.clock.now().toISOString(),
      requiresCredentials: false,
      credentialsPresent: true,
    };
  }
}
