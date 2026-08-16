/**
 * Benner cycle — an experiment, not a belief.
 *
 * Samuel Benner published a chart in 1875 predicting recurring years of panic,
 * good times and hard times. It circulates widely as a market-timing device.
 *
 * The prior here should be close to zero: a 19th-century pattern derived from
 * pig-iron and corn prices has no proposed mechanism connecting it to
 * 21st-century equity returns, the year lists are sparse enough to fit almost
 * any narrative in hindsight, and the cycle has been retro-fitted repeatedly.
 *
 * It is implemented so it can be **falsified**, at weight zero by default. The
 * intended lifecycle is: run the with/without comparison out of sample once,
 * publish the number, and if it does not improve results, delete this file
 * rather than leave a dormant feature to be re-enabled on a hopeful afternoon.
 */

/** Years the chart marks as panics — widely circulated figures. */
export const PANIC_YEARS = [1927, 1945, 1965, 1981, 1999, 2019, 2035];

/** Years marked "good times, high prices — sell". */
export const SELL_YEARS = [1926, 1935, 1945, 1953, 1962, 1972, 1980, 1989, 1999, 2007, 2018, 2026];

/** Years marked "hard times, low prices — buy". */
export const BUY_YEARS = [1931, 1942, 1951, 1958, 1967, 1975, 1985, 1996, 2005, 2012, 2023, 2032];

export type BennerPhase = 'panic' | 'sell' | 'buy' | 'neutral';

export interface BennerSignal {
  year: number;
  phase: BennerPhase;
  /** Directional tilt in [-1, 1]. Zero for neutral years. */
  tilt: number;
  /** Configurable weight. Default zero — the feature is off until proven. */
  weight: number;
  note: string;
}

export interface BennerOptions {
  /** Weight in [0,1]. Defaults to 0: no influence on any decision. */
  weight?: number;
  /** Treat a year adjacent to a marked year as partially in phase. */
  includeAdjacentYears?: boolean;
}

export function bennerSignal(date: Date, options: BennerOptions = {}): BennerSignal {
  const year = date.getUTCFullYear();
  const weight = Math.max(0, Math.min(1, options.weight ?? 0));

  const classify = (): { phase: BennerPhase; tilt: number } => {
    if (PANIC_YEARS.includes(year)) return { phase: 'panic', tilt: -1 };
    if (SELL_YEARS.includes(year)) return { phase: 'sell', tilt: -0.6 };
    if (BUY_YEARS.includes(year)) return { phase: 'buy', tilt: 0.6 };

    if (options.includeAdjacentYears) {
      const near = (years: number[]) => years.some((y) => Math.abs(y - year) === 1);
      if (near(PANIC_YEARS)) return { phase: 'panic', tilt: -0.4 };
      if (near(SELL_YEARS)) return { phase: 'sell', tilt: -0.25 };
      if (near(BUY_YEARS)) return { phase: 'buy', tilt: 0.25 };
    }
    return { phase: 'neutral', tilt: 0 };
  };

  const { phase, tilt } = classify();
  return {
    year,
    phase,
    tilt,
    weight,
    note:
      weight === 0
        ? 'Benner cycle is recorded but carries zero weight — it influences nothing until an out-of-sample test justifies it.'
        : `Benner cycle applied at weight ${weight}. This has an extraordinarily weak prior; verify out of sample before trusting it.`,
  };
}

/**
 * Apply the tilt to a score.
 *
 * With the default weight of zero this is the identity function, which is the
 * point: enabling the feature must be a deliberate act.
 */
export function applyBennerTilt(score: number, signal: BennerSignal): number {
  if (signal.weight === 0) return score;
  const adjusted = score * (1 + signal.tilt * signal.weight);
  return Math.max(0, Math.min(1, Number(adjusted.toFixed(4))));
}
