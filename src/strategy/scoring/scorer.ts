import type { MarketEvent } from '../../intelligence/types.js';
import type { MarketRegime } from '../regime.js';
import type { LlmHypothesis, ScoreComponent } from '../signals/types.js';

/**
 * Composite signal scoring.
 *
 * The brief asks for a score that combines source quality, confirmation, event
 * importance, price reaction, volume, volatility, macro regime, model
 * confidence and historical performance. This implements that as an explicit,
 * inspectable weighted sum — every component and weight is recorded on the
 * signal, so any score can be taken apart afterwards.
 *
 * Two deliberate properties:
 *
 * 1. **The model's confidence is one input among many, capped at 30% of the
 *    weight.** A confident model with weak sourcing scores low. This is the
 *    arithmetic expression of "never trade on the model's say-so".
 *
 * 2. **Some conditions multiply the score toward zero rather than subtracting
 *    from it.** Contradicted events, suspected manipulation, and social-only
 *    sourcing are not "a few points off" — they invalidate the premise.
 */

export interface ScoringInputs {
  event: MarketEvent;
  hypothesis: LlmHypothesis;
  /** Recent return in percent, if price history is available. */
  recentReturnPct?: number;
  /** Volume over its trailing average. */
  volumeRatio?: number;
  /** Annualised realised volatility in percent. */
  volatilityPct?: number;
  regime?: MarketRegime;
  /**
   * Historical hit rate for this event type, from the decision journal.
   * Undefined until enough outcomes exist — and it stays undefined for a long
   * time, because a handful of trades cannot establish a hit rate.
   */
  historicalHitRate?: number;
  historicalSampleSize?: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponent[];
  /** Multiplicative penalties applied after the weighted sum. */
  vetoes: string[];
}

const WEIGHTS = {
  sourceQuality: 0.18,
  confirmation: 0.16,
  eventImportance: 0.14,
  modelConfidence: 0.16,
  impactStrength: 0.12,
  priceReaction: 0.08,
  volume: 0.06,
  volatility: 0.05,
  regime: 0.05,
} as const;

/** Volatility above this is treated as an unfavourable environment. */
const HIGH_VOLATILITY_PCT = 45;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreSignal(inputs: ScoringInputs): ScoreResult {
  const { event, hypothesis } = inputs;
  const components: ScoreComponent[] = [];
  const vetoes: string[] = [];

  const bestReliability = Math.max(
    0,
    ...event.verification.authoritativeSources.map(() => 1),
    event.verification.confidence,
  );

  const push = (name: string, value: number, weight: number, note?: string) => {
    components.push({ name, value: Number(clamp01(value).toFixed(3)), weight, ...(note ? { note } : {}) });
  };

  push('source_quality', bestReliability, WEIGHTS.sourceQuality, 'best available source reliability');

  // Independent corroboration saturates: the third outlet adds less than the
  // second, and the tenth adds nothing.
  const confirmation =
    event.verification.status === 'officially_confirmed'
      ? 1
      : Math.min(0.85, 0.35 + 0.25 * (event.verification.independentReports - 1));
  push('confirmation', confirmation, WEIGHTS.confirmation, event.verification.status);

  push('event_importance', event.materiality, WEIGHTS.eventImportance);
  push('model_confidence', hypothesis.confidence, WEIGHTS.modelConfidence, 'capped share of total weight');
  push('impact_strength', hypothesis.impact_strength, WEIGHTS.impactStrength);

  // Price reaction: a move already in the signal's direction is evidence the
  // market agrees — and also evidence the edge may already be gone.
  if (inputs.recentReturnPct !== undefined) {
    const aligned =
      (hypothesis.action === 'BUY' && inputs.recentReturnPct > 0) ||
      (hypothesis.action === 'SELL' && inputs.recentReturnPct < 0);
    const magnitude = Math.min(1, Math.abs(inputs.recentReturnPct) / 5);
    // A large aligned move scores lower, not higher: being late is not an edge.
    const value = aligned ? Math.max(0.2, 0.7 - magnitude * 0.5) : 0.6;
    push('price_reaction', value, WEIGHTS.priceReaction, `recent ${inputs.recentReturnPct.toFixed(2)}%`);
  } else {
    push('price_reaction', 0.5, WEIGHTS.priceReaction, 'no price history — neutral');
  }

  if (inputs.volumeRatio !== undefined) {
    // Elevated volume corroborates that something real happened; extreme volume
    // suggests the move is already under way.
    const value = inputs.volumeRatio >= 4 ? 0.4 : Math.min(1, inputs.volumeRatio / 2.5);
    push('volume', value, WEIGHTS.volume, `${inputs.volumeRatio.toFixed(2)}x average`);
  } else {
    push('volume', 0.5, WEIGHTS.volume, 'unknown — neutral');
  }

  if (inputs.volatilityPct !== undefined) {
    // High volatility widens the distribution of outcomes; it does not improve
    // the odds of being right.
    const value = clamp01(1 - inputs.volatilityPct / (HIGH_VOLATILITY_PCT * 2));
    push('volatility', value, WEIGHTS.volatility, `${inputs.volatilityPct.toFixed(1)}% annualised`);
  } else {
    push('volatility', 0.5, WEIGHTS.volatility, 'unknown — neutral');
  }

  if (inputs.regime) {
    const favourable =
      (hypothesis.action === 'BUY' && inputs.regime.trend === 'bullish') ||
      (hypothesis.action === 'SELL' && inputs.regime.trend === 'bearish');
    const value = favourable ? 0.8 : inputs.regime.trend === 'neutral' ? 0.5 : 0.35;
    push('regime', value, WEIGHTS.regime, `${inputs.regime.trend}/${inputs.regime.volatility}`);
  } else {
    push('regime', 0.5, WEIGHTS.regime, 'unknown — neutral');
  }

  // Historical performance is included only once the sample is large enough to
  // mean anything. Below that it stays neutral rather than encoding noise.
  if (inputs.historicalHitRate !== undefined && (inputs.historicalSampleSize ?? 0) >= 30) {
    components.push({
      name: 'historical_hit_rate',
      value: Number(clamp01(inputs.historicalHitRate).toFixed(3)),
      weight: 0.05,
      note: `n=${inputs.historicalSampleSize}`,
    });
  } else if (inputs.historicalHitRate !== undefined) {
    components.push({
      name: 'historical_hit_rate',
      value: 0.5,
      weight: 0.05,
      note: `n=${inputs.historicalSampleSize ?? 0} — too few outcomes to use, held neutral`,
    });
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  let score = components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight;

  // --- Multiplicative vetoes -------------------------------------------
  if (event.verification.status === 'contradicted') {
    score *= 0.1;
    vetoes.push('event is contradicted — score reduced by 90%');
  }
  if (hypothesis.manipulation_suspected) {
    score *= 0.15;
    vetoes.push('model reported an attempt to steer it — score reduced by 85%');
  }
  if (event.sources.every((source) => source.startsWith('x:'))) {
    score *= 0.3;
    vetoes.push('social sources only — score reduced by 70%');
  }
  if (hypothesis.likely_priced_in) {
    score *= 0.6;
    vetoes.push('model judged the information already priced in');
  }
  if (hypothesis.action === 'HOLD' || hypothesis.action === 'WATCH') {
    // Non-directional proposals are not scored as trade candidates at all.
    score = Math.min(score, 0.2);
    vetoes.push('non-directional action — not a trade candidate');
  }

  return { score: Number(clamp01(score).toFixed(4)), components, vetoes };
}
