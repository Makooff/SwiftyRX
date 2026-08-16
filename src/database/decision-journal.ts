import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Clock, systemClock } from '../core/clock.js';
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
 */

export interface JournalEntry {
  timestamp: string;
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

  private async append(entry: JournalEntry): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Entries recorded by this process. */
  get entries(): JournalEntry[] {
    return [...this.buffer];
  }

  /** Read the full journal from disk, including earlier runs. */
  async readAll(): Promise<JournalEntry[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as JournalEntry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
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
