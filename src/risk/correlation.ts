import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Bar } from '../domain/types.js';

/**
 * Correlation groups, estimated from historical returns.
 *
 * The Risk Engine limits exposure to any one correlated group, and reads that
 * group as a label on the order and on each held position. Nothing populated
 * that label, so the limit never ran: `MAX_CORRELATED_EXPOSURE_PERCENT` was
 * printed by `config:check`, shown on the dashboard, and enforced on nothing.
 * This produces the labels.
 *
 * Two honest limits on what this can be:
 *
 *  - Correlation is estimated over one past window and is not stable across
 *    regimes. Precisely when it matters — a sell-off — correlations rise
 *    toward one and the groups measured in calm markets understate the
 *    concentration. The file records its own window so a stale or narrow
 *    estimate is visible as such.
 *  - Grouping is single-linkage: A and C land together if each correlates with
 *    B, even when they do not correlate with each other. For a limit whose
 *    purpose is to refuse concentration, erring toward larger groups is the
 *    cautious direction, and that is the direction chosen.
 */

export interface CorrelationGroupsFile {
  generatedAt: string;
  /** Window the returns were measured over, so a stale file is visible. */
  windowDays: number;
  /** |correlation| at or above which two symbols were joined. */
  threshold: number;
  /** Trading days actually shared by the pair with the fewest. */
  minObservations: number;
  /** Symbol -> group label. Symbols with no correlated peer map to themselves. */
  groups: Record<string, string>;
}

/**
 * Close-to-close returns over the sessions two symbols actually share.
 *
 * Aligned on timestamp rather than by index: a symbol that did not trade on a
 * given day — a halt, a later listing, a provider gap — would otherwise shift
 * every subsequent return against the other series, which quietly measures
 * something that is not correlation at all.
 */
export function alignedReturns(a: Bar[], b: Bar[]): { a: number[]; b: number[] } {
  const byTimestamp = new Map(b.map((bar) => [bar.timestamp, bar.close]));
  const shared: Array<{ a: number; b: number }> = [];
  for (const bar of a) {
    const other = byTimestamp.get(bar.timestamp);
    if (other !== undefined) shared.push({ a: bar.close, b: other });
  }

  const returnsA: number[] = [];
  const returnsB: number[] = [];
  for (let i = 1; i < shared.length; i += 1) {
    const prev = shared[i - 1]!;
    const current = shared[i]!;
    // A non-positive close is bad data, not a -100% return. Dropping the pair
    // keeps both series aligned, which dropping one side would not.
    if (prev.a <= 0 || prev.b <= 0) continue;
    returnsA.push(current.a / prev.a - 1);
    returnsB.push(current.b / prev.b - 1);
  }

  return { a: returnsA, b: returnsB };
}

/**
 * Pearson correlation. Returns undefined rather than a number when there is
 * nothing to correlate — fewer than two points, or a series that never moved,
 * which has no defined correlation with anything.
 */
export function pearson(a: number[], b: number[]): number | undefined {
  if (a.length !== b.length || a.length < 2) return undefined;

  const n = a.length;
  const meanA = a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = b.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < n; i += 1) {
    const devA = a[i]! - meanA;
    const devB = b[i]! - meanB;
    covariance += devA * devB;
    varianceA += devA * devA;
    varianceB += devB * devB;
  }

  if (varianceA <= 0 || varianceB <= 0) return undefined;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Minimum shared sessions before a pairwise correlation is believed at all. */
export const MIN_SHARED_SESSIONS = 60;

/** Default joining threshold on |correlation|. */
export const DEFAULT_THRESHOLD = 0.7;

export interface EstimateOptions {
  threshold?: number;
  minObservations?: number;
}

/**
 * Group symbols by correlated returns, single-linkage.
 *
 * A symbol correlated with nothing forms its own group, so every symbol always
 * has a label: an unlabelled symbol is one the exposure limit would skip, and
 * skipping is what this exists to stop.
 *
 * Groups are labelled by their alphabetically first member, so the same input
 * always produces the same file and a diff means the estimate moved.
 */
export function estimateGroups(
  barsBySymbol: Map<string, Bar[]>,
  options: EstimateOptions = {},
): Record<string, string> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minObservations = options.minObservations ?? MIN_SHARED_SESSIONS;
  const symbols = [...barsBySymbol.keys()].sort();

  // Union-find over pairs above the threshold.
  const parent = new Map<string, string>(symbols.map((symbol) => [symbol, symbol]));
  const find = (symbol: string): string => {
    let root = symbol;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (x: string, y: string) => {
    const rootX = find(x);
    const rootY = find(y);
    if (rootX === rootY) return;
    // Keep the alphabetically smaller root, so labels are deterministic.
    if (rootX < rootY) parent.set(rootY, rootX);
    else parent.set(rootX, rootY);
  };

  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const first = symbols[i]!;
      const second = symbols[j]!;
      const { a, b } = alignedReturns(barsBySymbol.get(first)!, barsBySymbol.get(second)!);
      if (a.length < minObservations) continue;
      const rho = pearson(a, b);
      // Absolute value: two names that move hard in opposite directions are
      // one bet expressed twice, not a diversified pair.
      if (rho !== undefined && Math.abs(rho) >= threshold) union(first, second);
    }
  }

  return Object.fromEntries(symbols.map((symbol) => [symbol, find(symbol)]));
}

export function writeCorrelationFile(path: string, file: CorrelationGroupsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/**
 * The groups as the agent reads them.
 *
 * Mirrors `EvidenceBook`: a missing or unreadable file yields no groups at all
 * rather than empty ones, so "never estimated" and "estimated, found nothing"
 * cannot look the same to a caller.
 */
export class CorrelationGroups {
  private constructor(readonly file: CorrelationGroupsFile) {}

  static load(path: string): CorrelationGroups | undefined {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as CorrelationGroupsFile;
      if (!parsed.groups || typeof parsed.groups !== 'object') return undefined;
      return new CorrelationGroups(parsed);
    } catch {
      return undefined;
    }
  }

  /** For tests and for the dashboard. */
  static fromFile(file: CorrelationGroupsFile): CorrelationGroups {
    return new CorrelationGroups(file);
  }

  /**
   * The group a symbol belongs to, or undefined when the estimate never saw it.
   *
   * Undefined is deliberate rather than falling back to the symbol itself: a
   * symbol the estimate has no opinion on should be reported as unconstrained,
   * not disguised as a group of one.
   */
  groupFor(symbol: string): string | undefined {
    return this.file.groups[symbol.toUpperCase()];
  }

  get symbolCount(): number {
    return Object.keys(this.file.groups).length;
  }

  /** Distinct groups, largest first — what the estimate actually concluded. */
  get clusters(): Array<{ group: string; symbols: string[] }> {
    const byGroup = new Map<string, string[]>();
    for (const [symbol, group] of Object.entries(this.file.groups)) {
      byGroup.set(group, [...(byGroup.get(group) ?? []), symbol]);
    }
    return [...byGroup.entries()]
      .map(([group, symbols]) => ({ group, symbols: symbols.sort() }))
      .sort((a, b) => b.symbols.length - a.symbols.length || a.group.localeCompare(b.group));
  }
}
