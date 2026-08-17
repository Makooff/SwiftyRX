import { type Clock, systemClock } from '../core/clock.js';
import { redact } from '../core/redact.js';

/**
 * In-memory activity log.
 *
 * The dashboard already shows *state* — what the portfolio holds, which
 * signals exist. This answers a different question: **what has the agent been
 * doing?** Without it, a healthy-looking page and a stuck loop are
 * indistinguishable, and "it isn't trading" cannot be told apart from "it
 * looked and decided not to".
 *
 * Deliberately a bounded ring buffer rather than a file: it is a window onto a
 * running process, not an audit trail. The decision journal is the record that
 * must survive, and it already exists.
 */

export type ActivityLevel = 'info' | 'good' | 'warn' | 'error';

export interface ActivityEntry {
  at: string;
  level: ActivityLevel;
  /** Short category, shown as a chip: cycle, event, signal, risk, order… */
  stage: string;
  message: string;
}

export interface ActivityLogOptions {
  /** Kept in memory. Older entries fall off the end. */
  capacity?: number;
  clock?: Clock;
}

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private readonly capacity: number;
  private readonly clock: Clock;

  constructor(options: ActivityLogOptions = {}) {
    this.capacity = options.capacity ?? 300;
    this.clock = options.clock ?? systemClock;
  }

  record(level: ActivityLevel, stage: string, message: string): void {
    this.entries.unshift({
      at: this.clock.now().toISOString(),
      level,
      stage,
      // Same chokepoint as the logs and the API: this text is rendered into a
      // page that may be reachable from the network.
      message: String(redact(message)).slice(0, 500),
    });
    if (this.entries.length > this.capacity) this.entries.length = this.capacity;
  }

  info(stage: string, message: string): void {
    this.record('info', stage, message);
  }

  good(stage: string, message: string): void {
    this.record('good', stage, message);
  }

  warn(stage: string, message: string): void {
    this.record('warn', stage, message);
  }

  error(stage: string, message: string): void {
    this.record('error', stage, message);
  }

  /** Newest first. */
  recent(limit = 100): ActivityEntry[] {
    return this.entries.slice(0, limit);
  }

  get size(): number {
    return this.entries.length;
  }
}
