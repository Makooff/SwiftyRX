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

/**
 * The same stages, named for somebody who did not build this.
 *
 * The operator reading the dashboard is not always the person who wrote the
 * pipeline, and "passed the analysis gate" describes the code rather than what
 * happened. These say what happened.
 *
 * Kept beside the English labels rather than replacing them: the stored
 * `summary`, the JSON diagnostic and the logs stay in one language, so a
 * saved cycle never comes back half-translated.
 */
export const FUNNEL_STAGE_LABELS_FR: Record<FunnelStage, string> = {
  ingest: 'Articles récupérés',
  events: 'Événements détectés',
  analysis_gate: 'Jugés dignes d’analyse',
  evidence_gate: 'Non écartés par les mesures passées',
  analysed: 'Analysés',
  signals: 'Avis produits',
  risk: 'Acceptés par le contrôle des risques',
  orders: 'Ordres passés',
};

/**
 * French for the drop reasons the pipeline actually emits.
 *
 * Two of them carry a configured number, so they are matched by shape rather
 * than by string. Anything unrecognised is returned untouched: a reason
 * invented downstream should reach the operator as it was written rather than
 * be silently dropped or mistranslated.
 */
export function funnelReasonFr(reason: string): string {
  const fixed: Record<string, string> = {
    contradicted: 'démentis',
    unclassified: 'non classables',
    'detection failed': 'échec de la détection',
    'ingestion failed': 'échec de la récupération',
    // Not "refused by the risk check": this reason is only ever shown against
    // the risk stage, whose own label already says that, and the pair read
    // together as one sentence saying the same thing twice.
    'risk rejected': 'au-delà des limites de risque',
    'observation only': 'source encore en observation',
    'not tradeable or halted': 'pas d’action identifiable, ou trading en pause',
    'approval rejected': 'validation refusée',
    'observation budget spent this cycle': 'budget d’observation épuisé pour ce cycle',
    'not processed — top 5 only': 'non traités — 5 par cycle au maximum',
  };
  if (fixed[reason]) return fixed[reason];

  const materiality = /^materiality below (.+)$/.exec(reason);
  if (materiality) return `importance sous ${materiality[1]}`;

  const confidence = /^confidence below (.+)$/.exec(reason);
  if (confidence) return `fiabilité sous ${confidence[1]}`;

  return reason;
}

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

/**
 * The same sentence in French, built at render time rather than stored.
 *
 * A cycle's `summary` is written once and kept in saved state, so translating
 * it there would leave old cycles in the old language for as long as the state
 * file lives. Deriving it from the steps means the whole history speaks
 * whatever the reader speaks today.
 */
export function summariseFunnelFr(steps: FunnelStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return 'Le cycle n’a pas démarré.';

  const label = FUNNEL_STAGE_LABELS_FR[last.stage].toLowerCase();

  if (last.count === 0) {
    const prev = steps[steps.length - 2];
    // No earlier step to compare against, so there is no "N → 0" to write.
    // The reasons still belong here: they are the whole content of the line.
    if (!prev) return `Aucun résultat à l’étape « ${label} »${reasonsTextFr(last.reasons)}.`;
    const prevLabel = FUNNEL_STAGE_LABELS_FR[prev.stage].toLowerCase();
    return `${prev.count} ${prevLabel} → 0 ${label}${reasonsTextFr(last.reasons)}.`;
  }

  if (last.stage === 'orders') {
    return last.count === 1 ? '1 ordre passé.' : `${last.count} ordres passés.`;
  }

  return `${label} : ${last.count} — le cycle s’est arrêté là${reasonsTextFr(last.reasons)}.`;
}

function reasonsTextFr(reasons: Record<string, number> | undefined): string {
  if (!reasons) return '';
  const parts = Object.entries(reasons).map(([reason, n]) => `${n} ${funnelReasonFr(reason)}`);
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
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
