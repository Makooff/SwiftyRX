import { hitRatesFrom, outcomeDueAt, pendingFrom, isEvaluable } from '../database/decision-journal.js';
import type { JournalEntry } from '../database/decision-journal.js';

/**
 * Settings the system recommends for itself, from what it has measured.
 *
 * The owner of this project does not want to arbitrate thresholds he has no
 * way to judge, which is fair. Three mechanisms already adapt on their own —
 * the scorer's hit-rate component, the evidence book, source promotion — and
 * all three read the decision journal. While it is empty they are inert, so
 * "let the bot decide" has a prerequisite nobody states: the bot must first
 * have decided something and been scored on it.
 *
 * This module is the honest version of that. It reports which of four states
 * the journal is in and only claims what that state supports.
 *
 * Two rules hold throughout, and they are the whole reason this is a module
 * with tests rather than a paragraph in a script:
 *
 *  1. **Recommend from outcomes, never from activity.** A system that lowers
 *     its own bar because it has not traded enough has learnt nothing — it has
 *     found a way to agree with itself. The only permitted input is
 *     `outcome.directionCorrect`: what the market actually did afterwards.
 *
 *  2. **An allowlist, not a denylist.** Only the keys in TUNABLE_KEYS can ever
 *     be written. Risk limits, instrument permissions and credentials are not
 *     absent from a list of exclusions; they are absent from the list of
 *     things that exist. A new setting is un-tunable until someone adds it
 *     here deliberately.
 */

/**
 * The bar the scorer already imposes on itself before it will use a measured
 * hit rate (`scorer.ts`). Reused rather than chosen again: two different
 * minimum sample sizes in one system is two different opinions about when a
 * number means something.
 */
export const MIN_OUTCOMES_TO_RECOMMEND = 30;

/**
 * Every setting this may write, and nothing else.
 *
 * Each is a question about how much the system analyses and how confident it
 * must be to act — answerable, in principle, by measurement. Absent by
 * construction: anything that decides how much money is at risk, which
 * instruments are allowed, whether leverage or shorting is on, and every
 * credential. Those are questions of tolerance and of billing, and no hit rate
 * answers them.
 */
export const TUNABLE_KEYS = [
  'ENABLED_SOURCES',
  'MIN_EVENT_MATERIALITY',
  'MIN_EVENT_CONFIDENCE',
  'MIN_SIGNAL_SCORE',
  'MAX_EVENTS_ANALYSED_PER_CYCLE',
  'LLM_EFFORT',
  'ALLOW_MODEL_CHOSEN_ASSET',
] as const;

export type TunableKey = (typeof TUNABLE_KEYS)[number];

export function isTunable(key: string): key is TunableKey {
  return (TUNABLE_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// What state is the journal in?
// ---------------------------------------------------------------------------

export type JournalState =
  /** Nothing has been decided. Nothing can be measured. */
  | { kind: 'empty' }
  /** Decisions exist, none has been scored yet. */
  | { kind: 'no_outcomes'; decisions: number; duePending: number; nextDueAt?: string }
  /** Scored decisions exist, but too few for the scorer's own bar. */
  | { kind: 'too_few'; decisions: number; outcomes: number }
  /** Enough scored decisions to say something. */
  | { kind: 'measured'; decisions: number; outcomes: number };

/**
 * Which of the four states the journal is in.
 *
 * `decisions` counts directional entries only. A journal full of WATCH lines
 * has recorded reasoning but predicted nothing, and calling that "300
 * decisions" would overstate what is there — the scorer refuses to evaluate
 * them for exactly the same reason (`isDirectional`).
 */
export function classifyJournal(entries: JournalEntry[], now: Date): JournalState {
  const directional = entries.filter((entry) => entry.outcome !== null || isEvaluable(entry));
  if (directional.length === 0) return { kind: 'empty' };

  const outcomes = directional.filter((entry) => entry.outcome !== null).length;
  if (outcomes === 0) {
    const due = pendingFrom(entries, now);
    const soonest = directional
      .filter((entry) => !entry.outcome)
      .map((entry) => outcomeDueAt(entry).toISOString())
      .sort()[0];
    return {
      kind: 'no_outcomes',
      decisions: directional.length,
      duePending: due.length,
      ...(soonest ? { nextDueAt: soonest } : {}),
    };
  }

  return outcomes < MIN_OUTCOMES_TO_RECOMMEND
    ? { kind: 'too_few', decisions: directional.length, outcomes }
    : { kind: 'measured', decisions: directional.length, outcomes };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export interface Recommendation {
  key: TunableKey;
  /** The value in the .env today, or undefined when the line is absent. */
  current?: string;
  recommended: string;
  /** In French: this is read by the person who owns the bot, not by a peer. */
  why: string;
}

export type Basis = 'bootstrap' | 'measured';

export interface TuningReport {
  state: JournalState;
  /**
   * Where the recommendations come from. `bootstrap` means a human chose them
   * with domain judgement because there was nothing to measure — said plainly
   * rather than dressed up as an automatic decision.
   */
  basis: Basis;
  recommendations: Recommendation[];
  /** Per-event-type hit rates, reported but never acted on here. */
  hitRates: Record<string, { hitRate: number; sampleSize: number }>;
}

/** A key proposed by `.env.recommande`, with the comment that justifies it. */
export interface DesiredSetting {
  value: string;
  comment: string;
}

/**
 * The starting configuration, as a diff against what is configured today.
 *
 * `desired` comes from `.env.recommande`, which is versioned and commented in
 * French. Both the value and its justification are read from that file, so the
 * reason a setting is recommended is written once, where someone editing it
 * will see it — and cannot drift away from a copy kept in a script.
 */
export function bootstrapRecommendations(
  desired: Record<string, DesiredSetting>,
  current: Record<string, string>,
): Recommendation[] {
  const out: Recommendation[] = [];
  for (const [key, setting] of Object.entries(desired)) {
    // A value in .env.recommande that is not tunable is a mistake in that
    // file, and silently applying it would be the exact failure this module
    // exists to prevent.
    if (!isTunable(key)) continue;
    if (current[key] === setting.value) continue;
    out.push({
      key,
      ...(current[key] !== undefined ? { current: current[key] } : {}),
      recommended: setting.value,
      why: setting.comment || 'configuration de depart, choisie a la main faute de mesure',
    });
  }
  return out;
}

/**
 * Where the score bar belongs, according to the decisions that were scored.
 *
 * The method, stated so it can be argued with: walk candidate thresholds, and
 * for each one look only at the decisions that scored at or above it. Take the
 * lowest threshold whose measured hit rate clears `targetHitRate` while still
 * leaving `minKept` decisions behind it. Lowest, not best: a threshold picked
 * for the highest hit rate on this sample is a threshold fitted to this sample.
 *
 * Returns undefined when no candidate qualifies — which is a real answer, and
 * a more useful one than a number invented to fill the field.
 */
export function recommendedScoreThreshold(
  entries: JournalEntry[],
  options: { targetHitRate?: number; minKept?: number } = {},
): { threshold: number; hitRate: number; kept: number } | undefined {
  const targetHitRate = options.targetHitRate ?? 0.55;
  const minKept = options.minKept ?? 10;

  const scored = entries
    .filter((entry) => entry.outcome !== null)
    .map((entry) => ({ score: entry.score, correct: entry.outcome!.directionCorrect }));
  if (scored.length === 0) return undefined;

  for (let threshold = 0.2; threshold <= 0.9; threshold += 0.05) {
    const kept = scored.filter((row) => row.score >= threshold - 1e-9);
    if (kept.length < minKept) break; // raising it further only removes more
    const hitRate = kept.filter((row) => row.correct).length / kept.length;
    if (hitRate >= targetHitRate) {
      return {
        threshold: Number(threshold.toFixed(2)),
        hitRate: Number(hitRate.toFixed(3)),
        kept: kept.length,
      };
    }
  }
  return undefined;
}

/**
 * Recommendations from measurement.
 *
 * Only MIN_SIGNAL_SCORE is derivable here, and the limit is worth naming: the
 * journal records each decision's score, but not the materiality or the
 * classification confidence that let the event reach analysis in the first
 * place. So the two floors before the score bar cannot be tuned from this file
 * — only reported on. Recommending them anyway would mean inventing a
 * relationship the data does not contain.
 */
export function measuredRecommendations(
  entries: JournalEntry[],
  current: Record<string, string>,
): Recommendation[] {
  const best = recommendedScoreThreshold(entries);
  if (!best) return [];

  const value = String(best.threshold);
  if (current.MIN_SIGNAL_SCORE === value) return [];

  return [
    {
      key: 'MIN_SIGNAL_SCORE',
      ...(current.MIN_SIGNAL_SCORE !== undefined ? { current: current.MIN_SIGNAL_SCORE } : {}),
      recommended: value,
      why:
        `au-dessus de ${best.threshold}, ${best.kept} decisions mesurees ont eu ` +
        `raison ${Math.round(best.hitRate * 100)}% du temps`,
    },
  ];
}

export function buildReport(
  entries: JournalEntry[],
  current: Record<string, string>,
  desired: Record<string, DesiredSetting>,
  now: Date,
): TuningReport {
  const state = classifyJournal(entries, now);
  const hitRates = hitRatesFrom(entries);

  if (state.kind === 'measured') {
    return { state, basis: 'measured', recommendations: measuredRecommendations(entries, current), hitRates };
  }
  return { state, basis: 'bootstrap', recommendations: bootstrapRecommendations(desired, current), hitRates };
}

// ---------------------------------------------------------------------------
// When --apply must refuse
// ---------------------------------------------------------------------------

/** What a previous `--apply` did, so the next one can tell if anything is new. */
export interface AppliedRecord {
  appliedAt: string;
  basis: Basis;
  /** Outcomes in the journal at the time. The number a recommendation rests on. */
  outcomes: number;
  keys: string[];
}

/**
 * Why `--apply` will not run, or undefined if it may.
 *
 * The bootstrap is allowed exactly once, and only against an unmeasured
 * journal: it is a human's starting guess, and its whole purpose is to produce
 * the data that replaces it. Every application after that has to rest on more
 * outcomes than the last one did — otherwise a second run would re-apply the
 * same reasoning to the same evidence and call the result progress.
 */
export function applyRefusal(
  report: TuningReport,
  lastApplied: AppliedRecord | undefined,
): string | undefined {
  if (report.recommendations.length === 0) {
    return 'la configuration correspond deja a la recommandation, il n\'y a rien a changer';
  }

  if (report.basis === 'measured') {
    const outcomes = report.state.kind === 'measured' ? report.state.outcomes : 0;
    if (lastApplied && outcomes <= lastApplied.outcomes) {
      return (
        `deja applique le ${lastApplied.appliedAt.slice(0, 10)} sur ${lastApplied.outcomes} ` +
        `resultat(s), et il y en a toujours ${outcomes}. Rien de nouveau a mesurer, ` +
        `donc rien de nouveau a decider.`
      );
    }
    return undefined;
  }

  // Bootstrap. Allowed once, whatever the journal holds: it is the guess that
  // produces the data, so withholding it from a journal that is still thin
  // would be withholding the only thing that can thicken it.
  if (!lastApplied) return undefined;

  if (report.state.kind === 'too_few') {
    return (
      `${report.state.outcomes} resultat(s) mesure(s), il en faut ${MIN_OUTCOMES_TO_RECOMMEND} ` +
      `pour que le bot recommande lui-meme — c'est le seuil que le scoreur ` +
      `s'impose deja. La configuration de depart, elle, est deja appliquee.`
    );
  }
  return (
    `la configuration de depart a deja ete appliquee le ${lastApplied.appliedAt.slice(0, 10)}. ` +
    `Elle ne se reapplique pas : la suite doit venir de resultats mesures, ` +
    `pas d'un second avis sans donnee nouvelle.`
  );
}
