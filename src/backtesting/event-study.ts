import type { Bar } from '../domain/types.js';

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
 *  - A t-statistic and the sample size accompany every mean, because a mean
 *    over nine events is not a finding.
 *
 * ## What it cannot tell you
 *
 * Correlation over a sample, not a tradeable edge. It ignores costs, slippage,
 * capacity and the fact that a published effect tends to decay once it is
 * known. Treat a positive result as permission to test properly, never as a
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
  /** Share of events with a positive abnormal return. */
  hitRate: number;
  /** Standard deviation of abnormal returns, in percent. */
  stdDevPct: number;
  /** mean / (stdDev / sqrt(n)) — how far the mean is from zero. */
  tStat: number;
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

/** |t| above this is conventionally "significant" at ~5% for large samples. */
const T_THRESHOLD = 1.96;

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
}

export function runEventStudy(input: EventStudyInput): CategoryResult[] {
  const horizons = input.horizons ?? DEFAULT_HORIZONS;
  const byCategory = new Map<string, Map<number, number[]>>();

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

      const perHorizon = byCategory.get(event.category) ?? new Map<number, number[]>();
      const bucket = perHorizon.get(sessions) ?? [];
      bucket.push(abnormal);
      perHorizon.set(sessions, bucket);
      byCategory.set(event.category, perHorizon);
    }
  }

  const results: CategoryResult[] = [];

  for (const [category, perHorizon] of byCategory) {
    const horizonResults: HorizonResult[] = [];

    for (const sessions of horizons) {
      const values = perHorizon.get(sessions) ?? [];
      const n = values.length;
      const m = mean(values);
      const sd = stdDev(values);
      const tStat = n > 1 && sd > 0 ? m / (sd / Math.sqrt(n)) : 0;

      horizonResults.push({
        sessions,
        meanAbnormalPct: Number(m.toFixed(4)),
        medianAbnormalPct: Number(median(values).toFixed(4)),
        hitRate: n === 0 ? 0 : Number((values.filter((v) => v > 0).length / n).toFixed(3)),
        stdDevPct: Number(sd.toFixed(4)),
        tStat: Number(tStat.toFixed(3)),
        sampleSize: n,
      });
    }

    const largest = Math.max(...horizonResults.map((h) => h.sampleSize), 0);
    results.push({
      category,
      sampleSize: largest,
      horizons: horizonResults,
      verdict: verdictFor(largest, horizonResults),
    });
  }

  return results.sort((a, b) => b.sampleSize - a.sampleSize);
}

/**
 * The plain-language reading.
 *
 * Deliberately reluctant. The default answer is "no evidence", and it takes
 * both a real sample and a real t-statistic to say anything else — because the
 * failure mode this whole project guards against is a number that reads like a
 * finding.
 */
function verdictFor(sampleSize: number, horizons: HorizonResult[]): string {
  if (sampleSize === 0) return 'no usable observations';
  if (sampleSize < MIN_SAMPLE_FOR_A_CLAIM) {
    return `only ${sampleSize} observations — too few to conclude anything, whatever the means look like`;
  }

  const significant = horizons.filter((h) => Math.abs(h.tStat) >= T_THRESHOLD && h.sampleSize >= MIN_SAMPLE_FOR_A_CLAIM);
  if (significant.length === 0) {
    return `no abnormal drift distinguishable from noise across ${sampleSize} observations`;
  }

  return significant
    .map(
      (h) =>
        `+${h.sessions}d: ${h.meanAbnormalPct > 0 ? '+' : ''}${h.meanAbnormalPct}% abnormal (t=${h.tStat}, n=${h.sampleSize})`,
    )
    .join(' · ');
}
