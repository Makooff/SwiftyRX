import type { EventType } from '../intelligence/types.js';
import type { EvidenceBook } from './evidence.js';

/**
 * Observation mode: a new source can be watched before it is trusted.
 *
 * Connecting a data source is easy; knowing whether it predicts anything is
 * not. A source listed in OBSERVATION_ONLY_SOURCES is ingested, detected,
 * analysed and journalled exactly as any other — but it cannot place an order
 * until the event study has actually measured the category its events fall in.
 *
 * The analysis is deliberately still paid for. Stopping earlier would be
 * cheaper and would teach nothing: what makes this worth doing is that the
 * journal fills with decisions the source *would* have taken, and outcome
 * tracking scores them afterwards. That is a measured answer about a new
 * source, bought with LLM calls rather than with capital.
 *
 * Promotion is automatic. Nobody edits a list when a source proves itself: the
 * moment its category clears the study's sample and cluster bars, its events
 * stop being held back.
 */

export type ObservationVerdict =
  | { trades: true }
  | { trades: false; reason: string };

const ALLOWED: ObservationVerdict = { trades: true };

/**
 * Has the study said anything at all about this event type?
 *
 * `untested` means the category existed but never cleared the sample and
 * cluster bars, which is not a measurement. A type absent from the book has
 * not been looked at. Both leave a source in observation.
 *
 * Note that `adverse` counts as measured here — it is a real result. Such an
 * event never reaches this gate anyway, because the evidence gate refuses it
 * several steps earlier.
 */
function hasBeenMeasured(evidence: EvidenceBook | undefined, type: EventType): boolean {
  const entry = evidence?.forEventType(type);
  return entry !== undefined && entry.status !== 'untested';
}

/**
 * May an event from these sources reach the Risk Engine?
 *
 * An event is held back only when **every** source behind it is in
 * observation. One established source corroborating it is enough to let it
 * stand on that source's own footing — the same reasoning that lets a filing
 * carry an event a social post also mentions.
 */
export function observationVerdict(
  event: { sources: string[]; type: EventType },
  observationOnlySources: ReadonlySet<string>,
  evidence: EvidenceBook | undefined,
): ObservationVerdict {
  if (observationOnlySources.size === 0) return ALLOWED;
  if (event.sources.length === 0) return ALLOWED;

  const allObserved = event.sources.every((source) => observationOnlySources.has(source));
  if (!allObserved) return ALLOWED;

  if (hasBeenMeasured(evidence, event.type)) return ALLOWED;

  return {
    trades: false,
    reason: `observation only — ${event.type} not yet measured`,
  };
}
