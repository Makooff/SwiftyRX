import { type Clock, systemClock } from '../../core/clock.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type { MarketDataService } from '../../ingestion/market_data/index.js';
import type { MarketReaction } from '../types.js';

/**
 * Market reaction measurement.
 *
 * Answers a narrow question: after this event became public, did the price and
 * volume of the named asset behave unusually?
 *
 * Two caveats are load-bearing, and both are recorded on the result:
 *
 *  - **It is not evidence of truth.** A move shows the market reacted to
 *    something. A false rumour moves prices too — that is precisely how a fake
 *    story does damage.
 *  - **It must not become circular.** The verifier only scores this when the
 *    claim is already independently established, so a rumour cannot move a
 *    price and then have that move vouch for the rumour.
 *
 * Look-ahead safety: only bars timestamped at or after the event's publication
 * are considered. Measuring the move that preceded the news would manufacture
 * an edge that never existed.
 */

const ABNORMAL_RETURN_PCT = 2;
const ABNORMAL_VOLUME_RATIO = 2;
/** Bars used to establish the "normal" volume baseline. */
const BASELINE_BARS = 20;

export interface MeasureOptions {
  clock?: Clock;
  logger?: Logger;
  /** How long after publication to measure. */
  windowHours?: number;
}

export async function measureMarketReaction(
  marketData: MarketDataService,
  symbol: string,
  eventPublishedAt: string,
  options: MeasureOptions = {},
): Promise<MarketReaction | undefined> {
  const clock = options.clock ?? systemClock;
  const log = options.logger ?? createLogger('market-reaction');

  const eventMs = Date.parse(eventPublishedAt);
  if (Number.isNaN(eventMs)) return undefined;

  const windowMs = (options.windowHours ?? 24) * 3_600_000;
  const windowEndMs = Math.min(eventMs + windowMs, clock.nowMs());
  if (windowEndMs <= eventMs) return undefined; // event is in the future or now

  // Fetch a baseline period before the event as well, so "unusual" is measured
  // against this asset's own behaviour rather than an arbitrary threshold.
  const baselineStart = new Date(eventMs - BASELINE_BARS * 86_400_000 * 1.6);

  try {
    const { bars, provider } = await marketData.getBars(symbol, '1Day', {
      start: baselineStart,
      end: new Date(windowEndMs),
    });
    if (bars.length < 2) return undefined;

    const eventBars = bars.filter((bar) => Date.parse(bar.timestamp) >= eventMs);
    const baselineBars = bars.filter((bar) => Date.parse(bar.timestamp) < eventMs);
    if (eventBars.length === 0 || baselineBars.length === 0) return undefined;

    const priorClose = baselineBars[baselineBars.length - 1]!.close;
    const lastClose = eventBars[eventBars.length - 1]!.close;
    const returnPct = priorClose > 0 ? ((lastClose - priorClose) / priorClose) * 100 : 0;

    const baselineVolume =
      baselineBars.slice(-BASELINE_BARS).reduce((sum, bar) => sum + bar.volume, 0) /
      Math.min(BASELINE_BARS, baselineBars.length);
    const eventVolume = eventBars.reduce((sum, bar) => sum + bar.volume, 0) / eventBars.length;
    const volumeRatio = baselineVolume > 0 ? eventVolume / baselineVolume : 0;

    return {
      symbol,
      windowStart: new Date(eventMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      returnPct: Number(returnPct.toFixed(3)),
      volumeRatio: Number(volumeRatio.toFixed(2)),
      abnormal: Math.abs(returnPct) >= ABNORMAL_RETURN_PCT || volumeRatio >= ABNORMAL_VOLUME_RATIO,
      provider,
      note:
        'A price move indicates the market reacted to something; it is not evidence that the underlying claim is true.',
    };
  } catch (err) {
    // Missing price history is normal (non-US listings, free-tier limits) and
    // must not stop event processing. The event simply carries no reaction.
    log.debug({ symbol, error: (err as Error).message }, 'no market reaction available');
    return undefined;
  }
}
