/**
 * The statistics a multi-category study needs and a single-hypothesis one does
 * not.
 *
 * The event study tests roughly forty filing categories at three horizons
 * each — well over a hundred hypotheses in one run. Judging each of them at
 * the conventional 5% threshold means expecting five or six "findings" from
 * pure noise before a single real effect exists. The first full run produced
 * exactly seven, every one of them with a t-statistic sitting between 2.0 and
 * 2.9: the signature of a threshold being crossed by chance, not of an effect.
 *
 * A study that reports those seven as findings is not being optimistic, it is
 * being wrong, and it is the precise failure this project was built to avoid.
 * So the threshold is set for the number of tests actually run.
 */

/**
 * Continued-fraction expansion for the incomplete beta function.
 *
 * Lentz's method, as in Numerical Recipes §6.4. Converges in a handful of
 * iterations across the range this code uses.
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-30;
  const EPS = 3e-12;
  const MAX_ITERATIONS = 200;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    // Odd step.
    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;

    if (Math.abs(delta - 1) < EPS) break;
  }

  return h;
}

/**
 * Lanczos approximation to log Γ(x), g=5, n=6.
 *
 * The published constants carry more digits than a double holds; they are
 * written here at the precision that actually survives, since a literal that
 * silently rounds is a literal nobody can check against the source.
 */
function logGamma(x: number): number {
  const COEFFICIENTS = [
    76.18009172947146, -86.50532032941678, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  const SERIES_BASE = 1.000000000190015;
  const SQRT_TWO_PI = Math.sqrt(2 * Math.PI);

  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let series = SERIES_BASE;
  for (const coefficient of COEFFICIENTS) series += coefficient / ++y;
  return -tmp + Math.log((SQRT_TWO_PI * series) / x);
}

/** Regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );

  // The expansion converges quickly only on one side; the symmetry relation
  // I_x(a,b) = 1 - I_{1-x}(b,a) covers the other.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Two-sided p-value for a t-statistic on `df` degrees of freedom.
 *
 * The t-distribution rather than the normal, because a standard error
 * clustered over 12 symbols has 11 degrees of freedom, not infinite. Using the
 * normal there understates the p-value by enough to matter at exactly the
 * threshold where these decisions get made.
 */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  if (t === 0) return 1;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

export interface FdrResult {
  /** Indices of the input p-values judged discoveries. */
  discoveries: Set<number>;
  /** The largest p-value that survived, or undefined if none did. */
  cutoff?: number;
  /** How many hypotheses were weighed. */
  tests: number;
}

/**
 * Benjamini–Hochberg false-discovery-rate control at level `q`.
 *
 * Chosen over Bonferroni deliberately. Bonferroni controls the chance of *any*
 * false positive, which across a hundred exploratory tests is so strict that a
 * genuine but modest effect could never surface. BH instead bounds the
 * expected share of the reported findings that are false — at q=0.10, at most
 * one in ten. For a screen whose whole purpose is deciding what deserves a
 * proper test next, that is the right question.
 */
export function benjaminiHochberg(pValues: number[], q: number): FdrResult {
  const m = pValues.length;
  if (m === 0) return { discoveries: new Set(), tests: 0 };

  const ordered = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);

  // The largest rank k whose p-value clears k/m · q. Everything ranked at or
  // below it is a discovery, including entries above their own threshold —
  // that step-up is what separates BH from a naive per-test cutoff.
  let largestPassingRank = -1;
  for (let k = 0; k < m; k++) {
    if (ordered[k]!.p <= ((k + 1) / m) * q) largestPassingRank = k;
  }

  if (largestPassingRank < 0) return { discoveries: new Set(), tests: m };

  const discoveries = new Set<number>();
  for (let k = 0; k <= largestPassingRank; k++) discoveries.add(ordered[k]!.index);

  return { discoveries, cutoff: ordered[largestPassingRank]!.p, tests: m };
}
