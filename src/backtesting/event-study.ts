import type { Bar } from '../domain/types.js';
import { benjaminiHochberg, studentTTwoSidedP } from './stats.js';

/**
 * Event study: does a class of event carry any information at all?
 *
 * This exists because the backtest engine measures a *strategy* — and the only
 * strategies it had were a moving-average crossover and buy & hold. Neither is
 * the thing this project actually built. Nothing here had ever measured whether
 * an SEC filing of a given type is followed by an abnormal move.
 *
 * That question comes first, and it is far cheaper to answer. If 8-K earnings
 * filings are followed by no abnormal drift, then no amount of model cleverness
 * downstream can extract an edge from them: there is nothing to extract. Paying
 * for LLM calls to interpret events that carry no information is the most
 * expensive way to learn that.
 *
 * ## Method
 *
 *  - Entry at the **open of the next session** after the filing. A filing at
 *    16:05 cannot be traded at that day's close, and pretending otherwise is
 *    the standard way event studies flatter themselves.
 *  - Returns measured to +1, +5 and +20 sessions.
 *  - **Abnormal** return, not raw: the benchmark's return over the identical
 *    window is subtracted. Without that, a study run over a bull market
 *    "discovers" that every event type is bullish.
 *  - **Standard errors clustered by symbol.** 2,700 Form 4 filings across 40
 *    tickers are not 2,700 independent observations: one company's filings
 *    share that company's whole history, and at a 20-session horizon their
 *    windows physically overlap. The naive t-statistic treats them as
 *    independent and is inflated — often by a factor of three or more. Both are
 *    reported; only the clustered one is allowed to support a verdict.
 *  - **Net of costs.** A mean of +0.29% is not an edge if the round trip costs
 *    0.30%. Every mean is reported alongside what survives the cost model.
 *  - **A threshold set for the number of tests actually run.** Forty categories
 *    at three horizons is over a hundred hypotheses, and judging each at 5%
 *    means expecting five or six "findings" from noise before a real effect
 *    exists. The first full run produced exactly seven, every one with a t
 *    between 2.0 and 2.9. Benjamini-Hochberg control across the whole run
 *    replaces the per-test cutoff.
 *
 * ## What it still cannot tell you
 *
 * Correlation over one sample of one market regime, not a tradeable edge. It
 * ignores capacity, borrow, and the fact that a published effect decays once it
 * is known. Treat a positive result as permission to test properly, never as a
 * reason to trade.
 */

export interface StudyEvent {
  symbol: string;
  /** When the event became public. */
  at: string;
  /** Grouping key: form type, event type, whatever is being tested. */
  category: string;
}

export interface HorizonResult {
  sessions: number;
  /** Mean abnormal return, in percent. */
  meanAbnormalPct: number;
  medianAbnormalPct: number;
  /** Mean abnormal return minus the modelled round-trip cost. */
  meanNetOfCostsPct: number;
  /** Share of events with a positive abnormal return. */
  hitRate: number;
  /** Standard deviation of abnormal returns, in percent. */
  stdDevPct: number;
  /**
   * mean / (stdDev / sqrt(n)), assuming every observation is independent.
   * Reported for comparison only — it is the number that makes a concentrated
   * sample look like a discovery.
   */
  naiveTStat: number;
  /**
   * The same mean over standard errors clustered by symbol. This is the one
   * that decides a verdict.
   */
  tStat: number;
  /**
   * Two-sided p-value for the clustered t, on clusters-1 degrees of freedom.
   * Not the normal approximation: a standard error clustered over 12 symbols
   * has 11 degrees of freedom, and pretending otherwise understates the
   * p-value at exactly the threshold where these calls get made.
   */
  pValue: number;
  /**
   * Did this test survive false-discovery-rate control across every test the
   * study ran? This, not the raw t, is what supports a verdict.
   */
  survivesMultiplicity: boolean;
  /** Distinct symbols contributing observations. */
  clusters: number;
  /** Share of observations contributed by the single busiest symbol. */
  largestClusterShare: number;
  sampleSize: number;
}

export interface CategoryResult {
  category: string;
  sampleSize: number;
  horizons: HorizonResult[];
  /** Plain-language reading, including when the honest reading is "nothing". */
  verdict: string;
}

const DEFAULT_HORIZONS = [1, 5, 20];

/** Below this, a mean is noise regardless of how large it looks. */
const MIN_SAMPLE_FOR_A_CLAIM = 30;

/**
 * Below this many distinct symbols, a clustered standard error is itself
 * unreliable and the "effect" may be one company's five-year run.
 */
const MIN_CLUSTERS_FOR_A_CLAIM = 10;

/**
 * A test must clear this before it is even *considered* — the conventional 5%
 * cutoff. Clearing it is no longer sufficient: see FDR_Q.
 *
 * Exported because the evidence book applies it directly when deciding to
 * *refuse* a category. Restating 1.96 there would be a second copy of this
 * standard, free to drift from this one.
 */
export const T_THRESHOLD = 1.96;

/**
 * Benjamini-Hochberg level. At q=0.10, at most one in ten reported findings is
 * expected to be false.
 *
 * Bonferroni was rejected deliberately: controlling the chance of *any* false
 * positive across a hundred exploratory tests is so strict that a genuine but
 * modest effect could never surface. For a screen whose purpose is deciding
 * what deserves a proper test next, bounding the false share is the right
 * question.
 */
const FDR_Q = 0.1;

/**
 * Round-trip cost of a modelled retail trade, as a percentage of notional:
 * €1 commission each way on a ~€2,000 position, plus 2.5bp half-spread and
 * 2.5bp slippage each way. Callers with a real broker schedule should pass
 * their own.
 */
export const DEFAULT_ROUND_TRIP_COST_PCT = 0.3;

interface Observation {
  symbol: string;
  abnormalPct: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * t-statistic for a mean, with standard errors clustered by symbol.
 *
 * Var(mean) = G/(G-1) · Σ_g (Σ_{i∈g} eᵢ)² / N², where eᵢ = rᵢ − mean.
 *
 * The intuition: within one symbol, residuals are allowed to be arbitrarily
 * correlated — they are summed before being squared, so a symbol whose filings
 * all sat on the same multi-year drift contributes one large deviation rather
 * than hundreds of small independent ones. With one cluster per observation
 * this reduces to the ordinary t-statistic.
 */
function clusteredTStat(observations: Observation[]): number {
  const n = observations.length;
  if (n < 2) return 0;

  const m = mean(observations.map((o) => o.abnormalPct));

  const residualSumBySymbol = new Map<string, number>();
  for (const observation of observations) {
    residualSumBySymbol.set(
      observation.symbol,
      (residualSumBySymbol.get(observation.symbol) ?? 0) + (observation.abnormalPct - m),
    );
  }

  const groups = residualSumBySymbol.size;
  if (groups < 2) return 0;

  let sumOfSquaredClusterResiduals = 0;
  for (const sum of residualSumBySymbol.values()) sumOfSquaredClusterResiduals += sum ** 2;

  const variance = (groups / (groups - 1)) * (sumOfSquaredClusterResiduals / n ** 2);
  if (!(variance > 0)) return 0;

  return m / Math.sqrt(variance);
}

/** Index of the first bar strictly after `at`. The entry bar. */
function firstBarAfter(bars: Bar[], at: string): number {
  const target = Date.parse(at);
  return bars.findIndex((bar) => Date.parse(bar.timestamp) > target);
}

/**
 * Return from the entry bar's open to the close `sessions` bars later.
 *
 * Returns undefined when the window runs past the available data — a truncated
 * window would silently bias the result toward whatever the last bars did.
 */
function forwardReturnPct(bars: Bar[], entryIndex: number, sessions: number): number | undefined {
  const exitIndex = entryIndex + sessions - 1;
  if (entryIndex < 0 || exitIndex >= bars.length) return undefined;
  const entry = bars[entryIndex]!.open;
  const exit = bars[exitIndex]!.close;
  if (!(entry > 0)) return undefined;
  return (exit / entry - 1) * 100;
}

export interface EventStudyInput {
  events: StudyEvent[];
  /** Daily bars per symbol, ascending by time. */
  barsBySymbol: Map<string, Bar[]>;
  /** Benchmark bars, used to subtract the market's move over the same window. */
  benchmarkBars?: Bar[];
  horizons?: number[];
  /**
   * Round-trip cost as a percentage of notional, subtracted from every mean.
   * Defaults to a modelled retail round trip.
   */
  roundTripCostPct?: number;
}

export function runEventStudy(input: EventStudyInput): CategoryResult[] {
  const horizons = input.horizons ?? DEFAULT_HORIZONS;
  const costPct = input.roundTripCostPct ?? DEFAULT_ROUND_TRIP_COST_PCT;
  const byCategory = new Map<string, Map<number, Observation[]>>();

  for (const event of input.events) {
    const bars = input.barsBySymbol.get(event.symbol);
    if (!bars || bars.length === 0) continue;

    const entryIndex = firstBarAfter(bars, event.at);
    if (entryIndex < 0) continue;

    const benchmarkIndex = input.benchmarkBars ? firstBarAfter(input.benchmarkBars, event.at) : -1;

    for (const sessions of horizons) {
      const raw = forwardReturnPct(bars, entryIndex, sessions);
      if (raw === undefined) continue;

      // Subtract the market over the identical window. Skipping this turns a
      // bull market into evidence that every event type is bullish.
      let abnormal = raw;
      if (input.benchmarkBars && benchmarkIndex >= 0) {
        const benchmark = forwardReturnPct(input.benchmarkBars, benchmarkIndex, sessions);
        if (benchmark === undefined) continue;
        abnormal = raw - benchmark;
      }

      const perHorizon = byCategory.get(event.category) ?? new Map<number, Observation[]>();
      const bucket = perHorizon.get(sessions) ?? [];
      bucket.push({ symbol: event.symbol, abnormalPct: abnormal });
      perHorizon.set(sessions, bucket);
      byCategory.set(event.category, perHorizon);
    }
  }

  const results: CategoryResult[] = [];

  for (const [category, perHorizon] of byCategory) {
    const horizonResults: HorizonResult[] = [];

    for (const sessions of horizons) {
      const observations = perHorizon.get(sessions) ?? [];
      const values = observations.map((o) => o.abnormalPct);
      const n = values.length;
      const m = mean(values);
      const sd = stdDev(values);
      const naive = n > 1 && sd > 0 ? m / (sd / Math.sqrt(n)) : 0;

      const countBySymbol = new Map<string, number>();
      for (const observation of observations) {
        countBySymbol.set(observation.symbol, (countBySymbol.get(observation.symbol) ?? 0) + 1);
      }
      const largest = Math.max(0, ...countBySymbol.values());

      const clustered = Number(clusteredTStat(observations).toFixed(3));
      // Degrees of freedom follow the clusters, not the observations.
      const degreesOfFreedom = countBySymbol.size - 1;
      const pValue =
        degreesOfFreedom > 0 ? studentTTwoSidedP(clustered, degreesOfFreedom) : 1;

      horizonResults.push({
        sessions,
        meanAbnormalPct: Number(m.toFixed(4)),
        medianAbnormalPct: Number(median(values).toFixed(4)),
        // The agent only ever goes long, so the cost is a straight subtraction:
        // a negative drift is not a short opportunity here, it is just worse.
        meanNetOfCostsPct: Number((m - costPct).toFixed(4)),
        hitRate: n === 0 ? 0 : Number((values.filter((v) => v > 0).length / n).toFixed(3)),
        stdDevPct: Number(sd.toFixed(4)),
        naiveTStat: Number(naive.toFixed(3)),
        tStat: clustered,
        pValue: Number(pValue.toFixed(6)),
        // Filled in below, once every test in the run is known. It cannot be
        // decided per category: that is the whole point.
        survivesMultiplicity: false,
        clusters: countBySymbol.size,
        largestClusterShare: n === 0 ? 0 : Number((largest / n).toFixed(3)),
        sampleSize: n,
      });
    }

    const largestSample = Math.max(...horizonResults.map((h) => h.sampleSize), 0);
    results.push({
      category,
      sampleSize: largestSample,
      horizons: horizonResults,
      verdict: '',
    });
  }

  applyMultiplicityControl(results);

  for (const result of results) {
    result.verdict = verdictFor(result.sampleSize, result.horizons, costPct);
  }

  return results.sort((a, b) => b.sampleSize - a.sampleSize);
}

/**
 * Every test the run actually made, whatever its outcome.
 *
 * The membership rule is deliberately outcome-blind: a horizon qualifies on
 * sample size and cluster count, both fixed before any return is looked at.
 * Admitting only the tests that already crossed |t|=1.96 would be selecting the
 * family on the result — the same bias the correction exists to remove, applied
 * one level up — and would let a hundred quiet tests vanish from the count that
 * is supposed to include them.
 */
function testableHorizons(results: CategoryResult[]): HorizonResult[] {
  const family: HorizonResult[] = [];
  for (const result of results) {
    for (const horizon of result.horizons) {
      if (
        horizon.sampleSize >= MIN_SAMPLE_FOR_A_CLAIM &&
        horizon.clusters >= MIN_CLUSTERS_FOR_A_CLAIM
      ) {
        family.push(horizon);
      }
    }
  }
  return family;
}

/**
 * Decide which tests survive, across the entire run rather than one at a time.
 *
 * Whether a t of 2.3 is a finding depends entirely on how many other tests were
 * run beside it, so this cannot be decided per category — which is why it is a
 * second pass over the finished results rather than part of building them.
 */
function applyMultiplicityControl(results: CategoryResult[]): void {
  const family = testableHorizons(results);
  const { discoveries } = benjaminiHochberg(
    family.map((horizon) => horizon.pValue),
    FDR_Q,
  );
  family.forEach((horizon, index) => {
    // The |t| bar is kept as a floor on top of FDR. With a large family BH is
    // the binding constraint anyway; with a small one it stops a p-value that
    // clears the step-up from reporting a mean that is visibly nothing.
    horizon.survivesMultiplicity =
      discoveries.has(index) && Math.abs(horizon.tStat) >= T_THRESHOLD;
  });
}

/** How many tests the run made, how many looked significant, how many survived. */
export function multiplicitySummary(results: CategoryResult[]): {
  /** Every test weighed, including the quiet ones. */
  tested: number;
  /** Those that crossed |t|=1.96 — what a per-test cutoff would have reported. */
  nominal: number;
  /** Those still standing once the whole family is accounted for. */
  survivors: number;
} {
  const family = testableHorizons(results);
  return {
    tested: family.length,
    nominal: family.filter((h) => Math.abs(h.tStat) >= T_THRESHOLD).length,
    survivors: family.filter((h) => h.survivesMultiplicity).length,
  };
}

/**
 * The plain-language reading.
 *
 * Deliberately reluctant. The default answer is "no evidence", and it takes a
 * real sample, a real spread of symbols and a real clustered t-statistic to say
 * anything else — because the failure mode this whole project guards against is
 * a number that reads like a finding.
 *
 * A surviving effect is then stated net of costs, because "significant" and
 * "worth trading" are different claims and only the second one matters.
 */
function verdictFor(sampleSize: number, horizons: HorizonResult[], costPct: number): string {
  if (sampleSize === 0) return 'no usable observations';
  if (sampleSize < MIN_SAMPLE_FOR_A_CLAIM) {
    return `only ${sampleSize} observations — too few to conclude anything, whatever the means look like`;
  }

  const clusters = Math.max(...horizons.map((h) => h.clusters), 0);
  if (clusters < MIN_CLUSTERS_FOR_A_CLAIM) {
    return `${sampleSize} observations but only ${clusters} distinct symbol(s) — this could be one company's history, not an effect`;
  }

  const significant = horizons.filter((h) => h.survivesMultiplicity);
  if (significant.length === 0) {
    // Distinguish "nothing here" from "something that would have passed alone".
    const nominal = horizons.filter(
      (h) =>
        Math.abs(h.tStat) >= T_THRESHOLD &&
        h.sampleSize >= MIN_SAMPLE_FOR_A_CLAIM &&
        h.clusters >= MIN_CLUSTERS_FOR_A_CLAIM,
    );
    if (nominal.length > 0) {
      return `crosses |t|=${T_THRESHOLD} at +${nominal.map((h) => h.sessions).join('/')}d but does not survive the number of tests this run made — expected from noise`;
    }
    return `no abnormal drift distinguishable from noise across ${sampleSize} observations`;
  }

  return significant
    .map((h) => {
      const sign = h.meanAbnormalPct > 0 ? '+' : '';
      const head = `+${h.sessions}d: ${sign}${h.meanAbnormalPct}% abnormal (t=${h.tStat} clustered over ${h.clusters} symbols, n=${h.sampleSize})`;
      if (h.meanAbnormalPct < 0) return `${head} — moves AGAINST a long`;
      return h.meanAbnormalPct <= costPct
        ? `${head} — smaller than the ${costPct}% round trip, so not tradeable`
        : `${head}, ${h.meanNetOfCostsPct}% net of costs`;
    })
    .join(' · ');
}
