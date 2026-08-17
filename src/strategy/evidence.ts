import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CategoryResult, HorizonResult } from '../backtesting/event-study.js';
import { SEC_FORM_RULES, SEC_ITEM_RULES } from '../intelligence/event_detector/rules.js';
import type { EventType } from '../intelligence/types.js';

/**
 * The evidence book: what the event study found, in a form the agent can act on.
 *
 * The study answers "does this class of filing carry information?" and then,
 * until now, the answer sat in a terminal and changed nothing. This closes that
 * loop in the one direction that is unambiguously safe.
 *
 * The asymmetry is deliberate:
 *
 *  - Evidence that a category drifts **against** a long, over a real sample and
 *    a real spread of symbols, **blocks** it. There is no argument for buying
 *    into a measured adverse drift, and the first real run found exactly that
 *    for 8-K item 2.02 — the earnings filings this agent was built to trade.
 *  - Evidence that a category drifts **for** a long does **not** license
 *    anything. It is one sample of one regime, tested alongside a dozen other
 *    categories, and a passing t-statistic among twelve tests is expected by
 *    chance. Support is recorded and shown; it never lowers a gate.
 *
 * That asymmetry is the honest reading of a single backtest, and it is what
 * keeps this from becoming a machine for finding reasons to trade.
 *
 * No file means no opinion: the agent behaves exactly as it did before. The
 * book is only ever consulted, never inferred.
 */

export type EvidenceStatus =
  /** Measured drift against a long, on a sample large enough to mean it. */
  | 'adverse'
  /** Statistically real, but smaller than the round trip it would cost. */
  | 'below_costs'
  /** Tested, nothing distinguishable from noise. */
  | 'inconclusive'
  /** Tested, positive, and larger than costs. Still not a licence. */
  | 'supported'
  /** Not enough observations, or too few distinct symbols, to say anything. */
  | 'untested';

export interface CategoryEvidence {
  /** The study's own label, e.g. "8-K item 2.02" or "10-Q". */
  category: string;
  /** The agent's event type, when the category maps onto one. */
  eventType?: EventType;
  status: EvidenceStatus;
  sampleSize: number;
  clusters: number;
  /** The horizon that drove the status, when one did. */
  horizon?: {
    sessions: number;
    meanAbnormalPct: number;
    meanNetOfCostsPct: number;
    tStat: number;
  };
  /** The study's plain-language verdict, carried through unchanged. */
  note: string;
}

export interface EvidenceFile {
  generatedAt: string;
  /** How the study was run, so a stale or narrow book is visible as such. */
  windowYears: number;
  benchmark?: string;
  roundTripCostPct: number;
  symbols: number;
  categories: CategoryEvidence[];
}

const T_THRESHOLD = 1.96;
const MIN_SAMPLE = 30;
const MIN_CLUSTERS = 10;

/**
 * Map a study category back onto the agent's event type.
 *
 * The mapping reuses the detector's own rules rather than restating them: a
 * second table would drift from the first, and then the book would be blocking
 * something other than what it measured.
 */
export function eventTypeForCategory(category: string): EventType | undefined {
  const itemMatch = /^8-K item (.+)$/.exec(category.trim());
  if (itemMatch) return SEC_ITEM_RULES[itemMatch[1]!.trim()]?.type;
  return SEC_FORM_RULES[category.trim()]?.type;
}

function significant(horizon: HorizonResult): boolean {
  return (
    horizon.sampleSize >= MIN_SAMPLE &&
    horizon.clusters >= MIN_CLUSTERS &&
    Math.abs(horizon.tStat) >= T_THRESHOLD
  );
}

function statusFor(result: CategoryResult): {
  status: EvidenceStatus;
  horizon?: HorizonResult;
} {
  const tested = result.horizons.filter(significant);
  if (tested.length === 0) {
    const enough =
      result.sampleSize >= MIN_SAMPLE &&
      Math.max(...result.horizons.map((h) => h.clusters), 0) >= MIN_CLUSTERS;
    return { status: enough ? 'inconclusive' : 'untested' };
  }

  // An adverse horizon decides the category even when another horizon looks
  // good: a drift that turns against the position inside the holding period is
  // not something to average away.
  const adverse = tested.filter((h) => h.meanAbnormalPct < 0);
  if (adverse.length > 0) {
    const worst = adverse.reduce((a, b) => (a.meanAbnormalPct <= b.meanAbnormalPct ? a : b));
    return { status: 'adverse', horizon: worst };
  }

  const best = tested.reduce((a, b) => (a.meanNetOfCostsPct >= b.meanNetOfCostsPct ? a : b));
  return { status: best.meanNetOfCostsPct > 0 ? 'supported' : 'below_costs', horizon: best };
}

export interface SummariseOptions {
  generatedAt: string;
  windowYears: number;
  benchmark?: string;
  roundTripCostPct: number;
  symbols: number;
}

export function summariseEvidence(
  results: CategoryResult[],
  options: SummariseOptions,
): EvidenceFile {
  return {
    generatedAt: options.generatedAt,
    windowYears: options.windowYears,
    ...(options.benchmark ? { benchmark: options.benchmark } : {}),
    roundTripCostPct: options.roundTripCostPct,
    symbols: options.symbols,
    categories: results.map((result) => {
      const { status, horizon } = statusFor(result);
      const eventType = eventTypeForCategory(result.category);
      return {
        category: result.category,
        ...(eventType ? { eventType } : {}),
        status,
        sampleSize: result.sampleSize,
        clusters: Math.max(...result.horizons.map((h) => h.clusters), 0),
        ...(horizon
          ? {
              horizon: {
                sessions: horizon.sessions,
                meanAbnormalPct: horizon.meanAbnormalPct,
                meanNetOfCostsPct: horizon.meanNetOfCostsPct,
                tStat: horizon.tStat,
              },
            }
          : {}),
        note: result.verdict,
      };
    }),
  };
}

export function writeEvidenceFile(path: string, file: EvidenceFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

/** Ranked worst-first, so a conflict between categories resolves to caution. */
const STATUS_RANK: Record<EvidenceStatus, number> = {
  adverse: 0,
  below_costs: 1,
  inconclusive: 2,
  untested: 3,
  supported: 4,
};

export class EvidenceBook {
  private readonly byEventType = new Map<EventType, CategoryEvidence>();

  private constructor(readonly file: EvidenceFile) {
    for (const entry of file.categories) {
      if (!entry.eventType) continue;
      const existing = this.byEventType.get(entry.eventType);
      // Forms 3, 4 and 5 all land on insider_transaction. If any of them drifts
      // against a long, the event type inherits that — the agent cannot tell
      // them apart at the point it decides.
      if (!existing || STATUS_RANK[entry.status] < STATUS_RANK[existing.status]) {
        this.byEventType.set(entry.eventType, entry);
      }
    }
  }

  /**
   * Load a book from disk. A missing or unreadable file yields no book at all
   * rather than an empty one, because "no evidence on record" and "evidence
   * that says nothing" should not look the same to a caller.
   */
  static load(path: string): EvidenceBook | undefined {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as EvidenceFile;
      if (!Array.isArray(parsed.categories)) return undefined;
      return new EvidenceBook(parsed);
    } catch {
      // A corrupt book is not silently treated as permission: it is treated as
      // no book, and the caller reports that it could not be read.
      return undefined;
    }
  }

  /** For tests and for the dashboard, which shows the book as it stands. */
  static fromFile(file: EvidenceFile): EvidenceBook {
    return new EvidenceBook(file);
  }

  forEventType(type: EventType): CategoryEvidence | undefined {
    return this.byEventType.get(type);
  }

  /**
   * Should the agent decline to act on this event type?
   *
   * Only 'adverse' blocks. Everything else — untested, inconclusive, even a
   * measured effect smaller than costs — passes through to the ordinary gates,
   * which are the ones designed to decide it.
   */
  blocks(type: EventType): CategoryEvidence | undefined {
    const entry = this.byEventType.get(type);
    return entry?.status === 'adverse' ? entry : undefined;
  }

  get categories(): CategoryEvidence[] {
    return this.file.categories;
  }
}
