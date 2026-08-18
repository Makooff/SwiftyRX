/**
 * Per-cycle funnel: how many items survived each stage, and why the rest did
 * not.
 *
 * `AgentState` only ever accumulates — it can tell you the lifetime total of
 * documents ingested, never whether *this* cycle's silence is the system
 * working (nothing worth trading today) or the system broken (a gate eating
 * everything). This is that distinction, one cycle at a time.
 */

export const FUNNEL_STAGES = [
  'ingest',
  'events',
  'analysis_gate',
  'evidence_gate',
  'analysed',
  'signals',
  'risk',
  'orders',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  ingest: 'Documents ingested',
  events: 'Events detected',
  analysis_gate: 'Passed analysis gate',
  evidence_gate: 'Passed evidence gate',
  analysed: 'Analysed',
  signals: 'Signals generated',
  risk: 'Passed risk',
  orders: 'Orders placed',
};

export interface FunnelStep {
  stage: FunnelStage;
  count: number;
  /** Why items were dropped at this stage, when any were — reason -> count. */
  reasons?: Record<string, number>;
}

export interface CycleFunnel {
  cycleId: number;
  startedAt: string;
  finishedAt: string;
  /** Only stages this cycle actually reached — a cycle stopped at ingest never asked about events. */
  steps: FunnelStep[];
  summary: string;
}

/**
 * Accumulates one cycle's steps as the pipeline runs, so every early exit
 * still produces a funnel — just a shorter one.
 *
 * Call `step()` only for a stage the cycle actually reached: a missing step
 * means "never asked", a step with count 0 means "asked, nothing survived".
 * The two must never be confused, or a broken pipeline and an idle one look
 * identical again — which is the exact problem this exists to fix.
 */
export class CycleFunnelBuilder {
  private readonly steps: FunnelStep[] = [];

  constructor(
    private readonly cycleId: number,
    private readonly startedAt: string,
  ) {}

  step(stage: FunnelStage, count: number, reasons?: Record<string, number>): void {
    this.steps.push(reasons && Object.keys(reasons).length > 0 ? { stage, count, reasons } : { stage, count });
  }

  finish(finishedAt: string): CycleFunnel {
    return {
      cycleId: this.cycleId,
      startedAt: this.startedAt,
      finishedAt,
      steps: this.steps,
      summary: summariseFunnel(this.steps),
    };
  }
}

function reasonsText(reasons: Record<string, number> | undefined): string {
  if (!reasons) return '';
  const parts = Object.entries(reasons).map(([reason, n]) => `${n} ${reason}`);
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
}

/**
 * One sentence: where the cycle stopped, and why. Reading this alone should
 * tell "the system works, there was nothing to do" apart from "the system is
 * stuck" — the two states a bare stat tile cannot tell apart.
 */
export function summariseFunnel(steps: FunnelStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return 'Cycle did not start.';

  const label = FUNNEL_STAGE_LABELS[last.stage];

  if (last.count === 0) {
    const prev = steps[steps.length - 2];
    if (!prev) return `${label}: none.`;
    const prevLabel = FUNNEL_STAGE_LABELS[prev.stage];
    return `${prev.count} ${prevLabel.toLowerCase()} → 0 ${label.toLowerCase()}${reasonsText(last.reasons)}.`;
  }

  if (last.stage === 'orders') {
    return `${last.count} order(s) placed.`;
  }

  return `${label.toLowerCase()}: ${last.count} — cycle ended here${reasonsText(last.reasons)}.`;
}

export interface CycleFunnelHistoryOptions {
  /** Kept in memory. Older cycles fall off the end. */
  capacity?: number;
}

/**
 * Bounded ring buffer of recent cycles, newest first — the same shape as
 * ActivityLog. Stores already-built `CycleFunnel`s, which carry their own
 * timestamps, so this needs no clock of its own.
 */
export class CycleFunnelHistory {
  private readonly entries: CycleFunnel[] = [];
  private readonly capacity: number;

  constructor(options: CycleFunnelHistoryOptions = {}) {
    this.capacity = options.capacity ?? 50;
  }

  record(funnel: CycleFunnel): void {
    this.entries.unshift(funnel);
    if (this.entries.length > this.capacity) this.entries.length = this.capacity;
  }

  /** Newest first. */
  recent(limit = 21): CycleFunnel[] {
    return this.entries.slice(0, limit);
  }

  get latest(): CycleFunnel | undefined {
    return this.entries[0];
  }

  get size(): number {
    return this.entries.length;
  }
}
