import { type Clock, systemClock } from '../core/clock.js';

/**
 * A daily ceiling on what analysis may cost.
 *
 * The agent estimates the price of every LLM call and has always shown it per
 * signal on the dashboard — but nothing ever added those numbers up, and
 * nothing ever stopped. On a laptop that is survivable: the window is open,
 * and closing it is the budget. On a server the operator is asleep, and an
 * unusually heavy news day spends unattended until somebody notices the
 * invoice.
 *
 * Not a wrapper around DailyQuota, though the rolling window is the same idea:
 * that class clamps `remaining` at zero, which is right for counting posts and
 * wrong here. A budget has to be able to say it went over, and by how much —
 * a call is billed after it returns, so the last one of the day can always
 * cross the line.
 *
 * The window rolls 24 hours from first use rather than at midnight in some
 * timezone. Nothing here needs to line up with a calendar day, and a fixed
 * offset is one more thing to get wrong on a server in another country.
 */
export class SpendBudget {
  private spent = 0;
  private windowStartMs: number;
  private announced = false;

  constructor(
    /** USD per 24 hours. Zero or less means no ceiling at all. */
    readonly limitUsd: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.windowStartMs = clock.nowMs();
  }

  private roll(): void {
    if (this.clock.nowMs() - this.windowStartMs >= 86_400_000) {
      this.spent = 0;
      this.windowStartMs = this.clock.nowMs();
      this.announced = false;
    }
  }

  get enforced(): boolean {
    return this.limitUsd > 0;
  }

  get spentUsd(): number {
    this.roll();
    return this.spent;
  }

  get remainingUsd(): number {
    this.roll();
    return this.limitUsd - this.spent;
  }

  /** Has the day's budget run out? Always false when no ceiling is set. */
  get exhausted(): boolean {
    return this.enforced && this.remainingUsd <= 0;
  }

  /**
   * Add what a call cost.
   *
   * An undefined cost is not free — it is unknown, which happens when the
   * provider publishes no pricing for the configured model. It is recorded as
   * zero because inventing a number would make the budget a fiction; the
   * doctor names that case instead, where a person can act on it.
   */
  record(costUsd: number | undefined): void {
    this.roll();
    if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd > 0) {
      this.spent += costUsd;
    }
  }

  /**
   * True once per window, the first time the budget is found exhausted.
   *
   * Every cycle would otherwise re-announce the same halt, and a Discord
   * channel that repeats itself every minute is a channel nobody reads on the
   * day it matters.
   */
  claimAnnouncement(): boolean {
    if (!this.exhausted || this.announced) return false;
    this.announced = true;
    return true;
  }

  /** For the dashboard and the daily summary. */
  snapshot(): { limitUsd: number; spentUsd: number; remainingUsd: number; exhausted: boolean } {
    return {
      limitUsd: this.limitUsd,
      spentUsd: Number(this.spentUsd.toFixed(4)),
      remainingUsd: Number(this.remainingUsd.toFixed(4)),
      exhausted: this.exhausted,
    };
  }
}
