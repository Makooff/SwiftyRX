import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { T_THRESHOLD, type CategoryResult, type HorizonResult } from '../backtesting/event-study.js';
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
 *    into a measured adverse drift.
 *  - Evidence that a category drifts **for** a long does **not** license
 *    anything. Even after false-discovery-rate control across the whole run,
 *    it is one sample of one market regime. Support is recorded and shown; it
 *    never lowers a gate.
 *
 * The two directions are held to different statistical bars, for the reasons
 * set out on `veto()` below: claiming an edge must survive the number of tests
 * the run made, refusing one must not depend on it.
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

/**
 * Event types a study could ever have an opinion about.
 *
 * `eventTypeForCategory` reads only the two SEC tables, so an event type that
 * appears in neither can never be attached to a measured category — and
 * therefore can never be blocked, however badly it performs. That includes
 * everything the keyword rules produce from press releases and feeds:
 * monetary_policy, macro_release, trade_policy, sanctions, legal_action,
 * guidance, product.
 *
 * Derived from the same tables rather than listed by hand, so it cannot fall
 * out of step with what the mapping actually does. It exists to make the gap
 * visible: silently trading types the evidence gate structurally cannot reach
 * is the failure this reports.
 */
export const MEASURABLE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  ...Object.values(SEC_ITEM_RULES).map((rule) => rule.type),
  ...Object.values(SEC_FORM_RULES).map((rule) => rule.type),
]);

/** Could any study result ever gate this event type? */
export function isMeasurable(type: EventType): boolean {
  return MEASURABLE_EVENT_TYPES.has(type);
}

/**
 * The sample a test needs before it means anything at all, in either direction.
 *
 * Restated here rather than inferred from `survivesMultiplicity` so the book's
 * own standard is legible without reading the study, and so an older or
 * hand-written file cannot slip through on a flag alone.
 */
function measurable(horizon: HorizonResult): boolean {
  return horizon.sampleSize >= MIN_SAMPLE && horizon.clusters >= MIN_CLUSTERS;
}

/**
 * Strong enough to *claim an edge*: false-discovery-rate control across every
 * test the run made. Unchanged, and deliberately strict.
 */
function discovery(horizon: HorizonResult): boolean {
  return measurable(horizon) && horizon.survivesMultiplicity;
}

/**
 * Strong enough to *refuse*: the nominal test, deliberately NOT corrected for
 * multiplicity.
 *
 * This looks like a double standard and is one, because the two errors are not
 * the same size. A false discovery puts money into noise; a false veto costs a
 * trade we would probably not have wanted. Benjamini-Hochberg bounds the share
 * of false *claims*, which is the wrong quantity to protect when the output is
 * a refusal.
 *
 * The structural reason matters more. BH's threshold depends on how many other
 * tests the run happened to make, so a category measured drifting against a
 * long could lose its veto because unrelated categories were added to the study
 * — the evidence against it unchanged, the block gone. Connecting more sources
 * would silently unblock things. Holding the veto to a fixed nominal bar makes
 * it **monotone**: adding tests elsewhere can never remove an existing refusal.
 */
function veto(horizon: HorizonResult): boolean {
  return (
    measurable(horizon) &&
    Math.abs(horizon.tStat) >= T_THRESHOLD &&
    horizon.meanAbnormalPct < 0
  );
}

function statusFor(result: CategoryResult): {
  status: EvidenceStatus;
  horizon?: HorizonResult;
} {
  // Refusal is decided first, and on its own bar. An adverse horizon settles
  // the category even when another horizon looks good: a drift that turns
  // against the position inside the holding period is not something to average
  // away.
  const adverse = result.horizons.filter(veto);
  if (adverse.length > 0) {
    const worst = adverse.reduce((a, b) => (a.meanAbnormalPct <= b.meanAbnormalPct ? a : b));
    return { status: 'adverse', horizon: worst };
  }

  const discovered = result.horizons.filter(discovery);
  if (discovered.length === 0) {
    const enough =
      result.sampleSize >= MIN_SAMPLE &&
      Math.max(...result.horizons.map((h) => h.clusters), 0) >= MIN_CLUSTERS;
    return { status: enough ? 'inconclusive' : 'untested' };
  }

  const best = discovered.reduce((a, b) => (a.meanNetOfCostsPct >= b.meanNetOfCostsPct ? a : b));
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
