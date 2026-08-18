import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Clock, systemClock } from '../core/clock.js';
import { horizonDays } from '../risk/position-manager.js';
import type { RiskDecision } from '../risk/types.js';
import type { Signal } from '../strategy/signals/types.js';
import type { Order } from '../execution/broker/types.js';

/**
 * Decision journal.
 *
 * Every decision is recorded — including the ones that produced no trade.
 * This exists to make one question answerable with evidence rather than
 * impressions:
 *
 *   "Do the signals this system generates actually work?"
 *
 * Answering it needs the rejected signals as much as the executed ones. A
 * journal of only the trades that happened is a survivorship-biased record that
 * will flatter the strategy.
 *
 * Stored as JSON Lines: append-only, greppable, and impossible to corrupt
 * halfway through in a way that loses earlier entries.
 *
 * That append-only property is why an outcome, which is only known days after
 * the decision, is written as its own line rather than by rewriting the
 * decision in place. `readAll` folds each outcome onto the decision it
 * completes, so callers see one entry with its outcome attached and never have
 * to know. Rewriting the file to patch a field would trade the guarantee in the
 * paragraph above for tidiness.
 */

export interface JournalEntry {
  timestamp: string;
  /**
   * The signal this decision came from — the key an outcome line refers back
   * to. Optional because entries written before outcomes existed have none, and
   * those can never be completed rather than being silently mismatched.
   */
  signalId?: string;
  /** The horizon the thesis claimed, which decides when the outcome is due. */
  expectedHorizon?: Signal['expectedHorizon'];
  eventId: string;
  eventType: string;
  eventHeadline: string;
  asset: string;
  signal: Signal['action'];
  /** The model's own confidence. */
  modelConfidence: number;
  /** Composite score after all factors. */
  score: number;
  priceAtSignal: number | null;
  verificationStatus: string;
  verificationConfidence: number;
  sources: string[];
  /** Null when no risk evaluation ran (e.g. no price available). */
  riskDecision: {
    verdict: string;
    quantity: number;
    notional: number;
    rejections: string[];
    riskPercent?: number;
  } | null;
  order: {
    id: string;
    status: string;
    filledPrice?: number;
    commission?: number;
    slippage?: number;
  } | null;
  /** Filled in later, when the outcome is known. */
  outcome: {
    evaluatedAt: string;
    priceAfter: number;
    returnPct: number;
    /** Did the direction the signal predicted actually happen? */
    directionCorrect: boolean;
    horizonDays: number;
  } | null;
  reasoning: {
    summary: string;
    catalyst: string;
    uncertainties: string[];
    /** Score components, so any number can be taken apart afterwards. */
    factors: Array<{ name: string; value: number; weight: number }>;
  };
  provenance: Signal['provenance'];
}

export type DecisionOutcome = NonNullable<JournalEntry['outcome']>;

/**
 * The second kind of line in the journal: an outcome completing an earlier
 * decision. Discriminated by `kind`, which decision lines never carry.
 */
export interface OutcomeRecord {
  kind: 'outcome';
  signalId: string;
  outcome: DecisionOutcome;
}

function isOutcomeRecord(line: unknown): line is OutcomeRecord {
  return typeof line === 'object' && line !== null && (line as OutcomeRecord).kind === 'outcome';
}

/**
 * Whether this action predicted a direction at all.
 *
 * HOLD and WATCH do not: the scorer calls them "non-directional" and caps their
 * score outright. Scoring them for correctness would need a definition of
 * "right" that nothing in the system states — so they are left unevaluated
 * rather than given an invented one.
 */
export function isDirectional(action: Signal['action']): boolean {
  return action === 'BUY' || action === 'SELL';
}

/** When a decision's horizon has run out and its outcome can be looked up. */
export function outcomeDueAt(entry: JournalEntry): Date {
  return new Date(
    Date.parse(entry.timestamp) + horizonDays(entry.expectedHorizon) * 86_400_000,
  );
}

/**
 * Can this entry ever receive an outcome?
 *
 * Deliberately separate from "is it due yet": an entry that will never be
 * evaluable should be skipped silently forever, whereas one that is merely
 * early should be retried.
 */
export function isEvaluable(entry: JournalEntry): boolean {
  return (
    !entry.outcome &&
    entry.signalId !== undefined &&
    isDirectional(entry.signal) &&
    entry.priceAtSignal !== null &&
    entry.priceAtSignal !== 0
  );
}

/**
 * Score a decision against the price its horizon actually produced.
 *
 * BUY is right when the price rose, SELL when it fell — the same idiom the
 * scorer already uses. A flat move counts as wrong for both: predicting a
 * direction and getting none is not a hit.
 */
export function buildOutcome(
  entry: JournalEntry,
  priceAfter: number,
  evaluatedAt: string,
): DecisionOutcome {
  const entryPrice = entry.priceAtSignal!;
  const returnPct = ((priceAfter - entryPrice) / entryPrice) * 100;
  return {
    evaluatedAt,
    priceAfter,
    returnPct,
    directionCorrect: entry.signal === 'BUY' ? returnPct > 0 : returnPct < 0,
    horizonDays: horizonDays(entry.expectedHorizon),
  };
}

export interface JournalOptions {
  path?: string;
  clock?: Clock;
}

export class DecisionJournal {
  private readonly path: string;
  private readonly clock: Clock;
  private readonly buffer: JournalEntry[] = [];

  constructor(options: JournalOptions = {}) {
    this.path = options.path ?? 'data/decisions.jsonl';
    this.clock = options.clock ?? systemClock;
  }

  async record(input: {
    signal: Signal;
    eventType: string;
    eventHeadline: string;
    verificationStatus: string;
    verificationConfidence: number;
    riskDecision?: RiskDecision;
    order?: Order;
  }): Promise<JournalEntry> {
    const { signal } = input;

    const entry: JournalEntry = {
      timestamp: this.clock.now().toISOString(),
      signalId: signal.id,
      expectedHorizon: signal.expectedHorizon,
      eventId: signal.eventId,
      eventType: input.eventType,
      eventHeadline: input.eventHeadline.slice(0, 300),
      asset: signal.asset,
      signal: signal.action,
      modelConfidence: signal.modelConfidence,
      score: signal.score,
      priceAtSignal: signal.priceAtSignal ?? null,
      verificationStatus: input.verificationStatus,
      verificationConfidence: input.verificationConfidence,
      sources: signal.sources,
      riskDecision: input.riskDecision
        ? {
            verdict: input.riskDecision.verdict,
            quantity: input.riskDecision.quantity,
            notional: input.riskDecision.notional,
            rejections: input.riskDecision.rejections.map((r) => r.rule),
            ...(input.riskDecision.riskPercent !== undefined
              ? { riskPercent: input.riskDecision.riskPercent }
              : {}),
          }
        : null,
      order: input.order
        ? {
            id: input.order.id,
            status: input.order.status,
            ...(input.order.filledPrice !== undefined ? { filledPrice: input.order.filledPrice } : {}),
            ...(input.order.commission !== undefined ? { commission: input.order.commission } : {}),
            ...(input.order.slippage !== undefined ? { slippage: input.order.slippage } : {}),
          }
        : null,
      outcome: null,
      reasoning: {
        summary: signal.reason.slice(0, 1500),
        catalyst: signal.catalyst,
        uncertainties: signal.uncertainties,
        factors: signal.components.map((c) => ({ name: c.name, value: c.value, weight: c.weight })),
      },
      provenance: signal.provenance,
    };

    this.buffer.push(entry);
    await this.append(entry);
    return entry;
  }

  private async append(line: JournalEntry | OutcomeRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
  }

  /**
   * Complete an earlier decision with what actually happened.
   *
   * Appended, never patched in place — see the note at the top of this file.
   * Re-recording the same signal is harmless: the last outcome on disk wins.
   */
  async recordOutcome(signalId: string, outcome: DecisionOutcome): Promise<void> {
    await this.append({ kind: 'outcome', signalId, outcome });
    const buffered = this.buffer.find((entry) => entry.signalId === signalId);
    if (buffered) buffered.outcome = outcome;
  }

  /** Entries recorded by this process. */
  get entries(): JournalEntry[] {
    return [...this.buffer];
  }

  /**
   * Read the full journal from disk, including earlier runs, with each outcome
   * folded onto the decision it completes.
   *
   * Callers see decisions, never the outcome lines themselves — the two-line
   * storage is an implementation detail of staying append-only.
   */
  async readAll(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const decisions: JournalEntry[] = [];
    const outcomes = new Map<string, DecisionOutcome>();

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as JournalEntry | OutcomeRecord;
      // Last outcome for a signal wins, so a re-evaluation supersedes rather
      // than duplicating.
      if (isOutcomeRecord(parsed)) outcomes.set(parsed.signalId, parsed.outcome);
      else decisions.push(parsed);
    }

    for (const decision of decisions) {
      if (!decision.signalId) continue;
      const outcome = outcomes.get(decision.signalId);
      if (outcome) decision.outcome = outcome;
    }

    return decisions;
  }

  /**
   * Decisions whose horizon has run out and whose outcome is still unknown,
   * oldest first.
   *
   * Pure and I/O-free beyond the read: whether a price is *available* for the
   * date is the caller's problem, because that is the part that costs an API
   * call.
   */
  async pendingOutcomes(now: Date): Promise<JournalEntry[]> {
    const entries = await this.readAll();
    return entries.filter(
      (entry) => isEvaluable(entry) && outcomeDueAt(entry).getTime() <= now.getTime(),
    );
  }

  /**
   * Hit rate per event type, from entries whose outcome is known.
   *
   * Returns the sample size alongside every rate, because a hit rate without
   * an n is not a statistic — and the scorer refuses to use one below n=30.
   */
  async hitRateByEventType(): Promise<Record<string, { hitRate: number; sampleSize: number }>> {
    const entries = await this.readAll();
    const buckets: Record<string, { wins: number; total: number }> = {};

    for (const entry of entries) {
      if (!entry.outcome) continue;
      const bucket = (buckets[entry.eventType] ??= { wins: 0, total: 0 });
      bucket.total += 1;
      if (entry.outcome.directionCorrect) bucket.wins += 1;
    }

    return Object.fromEntries(
      Object.entries(buckets).map(([type, { wins, total }]) => [
        type,
        { hitRate: total > 0 ? wins / total : 0, sampleSize: total },
      ]),
    );
  }
}
