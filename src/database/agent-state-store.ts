import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config/env.js';
import { type Clock, systemClock } from '../core/clock.js';
import type { PortfolioState } from '../execution/paper/portfolio.js';
import type { ManagedPosition } from '../risk/position-manager.js';

/**
 * Persistence for the paper agent's state.
 *
 * Without this, a restart resets the portfolio to its opening balance, and the
 * track record the project exists to build never accumulates past the longest
 * uninterrupted run. A few months of paper trading is already a thin basis for
 * judging a strategy; a few hours is none at all.
 *
 * Two deliberate choices:
 *
 *  - **The state file is refused, never reconciled, when it does not match the
 *    running configuration.** A state saved in one mode, currency or starting
 *    capital says nothing about a different one, and quietly adopting it would
 *    produce a P&L that is arithmetic on unrelated numbers. Mismatch is an
 *    error the operator resolves, not something this code guesses at.
 *  - **Reads are synchronous.** Loading happens once, before the first cycle,
 *    and an async constructor would push that complexity into every caller for
 *    no benefit. Writes go through a temp file and a rename, so a crash
 *    mid-write leaves the previous good state rather than a truncated one.
 */

export interface AgentCounters {
  cycles: number;
  documentsIngested: number;
  eventsDetected: number;
  signalsGenerated: number;
  ordersPlaced: number;
  ordersRejectedByRisk: number;
}

/**
 * Identity of the configuration a state file belongs to.
 *
 * Only fields whose change invalidates the stored numbers. Risk limits are
 * deliberately absent: tightening a limit mid-experiment should not throw away
 * the history, it should apply to the next decision.
 */
export interface StateFingerprint {
  mode: string;
  currency: string;
  initialCapital: number;
}

export interface PersistedAgentState {
  version: 1;
  savedAt: string;
  fingerprint: StateFingerprint;
  portfolio: PortfolioState;
  counters: AgentCounters;
  /** Client order ids already used, so duplicate protection survives a restart. */
  consumedOrderIds: string[];
  /**
   * Exit plans. Optional because state files written before exits existed do
   * not carry them — those positions are adopted with a default stop rather
   * than left unmanaged.
   */
  exitPlans?: ManagedPosition[];
  firstStartedAt: string;
}

export class StateMismatchError extends Error {
  constructor(
    readonly stored: StateFingerprint,
    readonly running: StateFingerprint,
    readonly path: string,
  ) {
    super(
      `Agent state at ${path} does not belong to this configuration.\n` +
        `  stored:  mode=${stored.mode} currency=${stored.currency} capital=${stored.initialCapital}\n` +
        `  running: mode=${running.mode} currency=${running.currency} capital=${running.initialCapital}\n` +
        'Delete or move the file to start a fresh run, or restore the configuration it was saved under.',
    );
    this.name = 'StateMismatchError';
  }
}

export function fingerprintOf(config: AppConfig): StateFingerprint {
  return {
    mode: config.MODE,
    currency: config.BASE_CURRENCY,
    initialCapital: config.initialCapital,
  };
}

export interface StateStoreOptions {
  path?: string;
  clock?: Clock;
}

export class AgentStateStore {
  readonly path: string;
  private readonly clock: Clock;

  constructor(options: StateStoreOptions = {}) {
    this.path = options.path ?? 'data/agent-state.json';
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Read the stored state, or `undefined` when there is none.
   *
   * Throws `StateMismatchError` on a configuration mismatch, and a plain error
   * on a corrupt file. Both are startup failures on purpose: continuing from a
   * state nobody can vouch for is how a paper run quietly becomes fiction.
   */
  load(running: StateFingerprint): PersistedAgentState | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }

    let parsed: PersistedAgentState;
    try {
      parsed = JSON.parse(raw) as PersistedAgentState;
    } catch (err) {
      throw new Error(`Agent state at ${this.path} is not valid JSON: ${(err as Error).message}`);
    }

    if (parsed.version !== 1) {
      throw new Error(`Unsupported agent state version at ${this.path}: ${String(parsed.version)}`);
    }

    const stored = parsed.fingerprint;
    if (
      stored.mode !== running.mode ||
      stored.currency !== running.currency ||
      stored.initialCapital !== running.initialCapital
    ) {
      throw new StateMismatchError(stored, running, this.path);
    }

    return parsed;
  }

  /** Write state atomically: temp file, then rename over the target. */
  save(input: {
    fingerprint: StateFingerprint;
    portfolio: PortfolioState;
    counters: AgentCounters;
    consumedOrderIds: string[];
    exitPlans?: ManagedPosition[];
    firstStartedAt: string;
  }): void {
    const state: PersistedAgentState = {
      version: 1,
      savedAt: this.clock.now().toISOString(),
      ...input,
    };

    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, this.path);
  }
}
