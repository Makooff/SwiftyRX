import { type Clock, systemClock } from '../core/clock.js';

/**
 * Minimal in-process metrics.
 *
 * Enough to answer "is ingestion working, how fast, and what is failing"
 * without pulling in a metrics backend. The recorded stage names already
 * anticipate the end-to-end latency chain
 * (event_detected -> analysis_started -> signal_created -> risk_checked ->
 * order_sent -> broker_ack); Phase 1 populates the ingestion stages only.
 */

export interface Histogram {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  /** Recent samples, used for percentiles. Bounded to keep memory flat. */
  samples: number[];
}

const MAX_SAMPLES = 500;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();

  constructor(private readonly clock: Clock = systemClock) {}

  increment(name: string, by = 1, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, durationMs: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const existing = this.histograms.get(key);
    if (!existing) {
      this.histograms.set(key, {
        count: 1,
        sumMs: durationMs,
        minMs: durationMs,
        maxMs: durationMs,
        samples: [durationMs],
      });
      return;
    }
    existing.count += 1;
    existing.sumMs += durationMs;
    existing.minMs = Math.min(existing.minMs, durationMs);
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    existing.samples.push(durationMs);
    if (existing.samples.length > MAX_SAMPLES) existing.samples.shift();
  }

  /** Time an async operation, recording success/failure counters alongside. */
  async time<T>(name: string, fn: () => Promise<T>, labels: Record<string, string> = {}): Promise<T> {
    const startedAt = this.clock.nowMs();
    try {
      const result = await fn();
      this.observe(name, this.clock.nowMs() - startedAt, { ...labels, outcome: 'success' });
      this.increment(`${name}.success`, 1, labels);
      return result;
    } catch (err) {
      this.observe(name, this.clock.nowMs() - startedAt, { ...labels, outcome: 'failure' });
      this.increment(`${name}.failure`, 1, labels);
      throw err;
    }
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return name;
    return `${name}{${entries.map(([k, v]) => `${k}=${v}`).join(',')}}`;
  }

  private percentile(samples: number[], p: number): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index] ?? 0;
  }

  snapshot(): {
    counters: Record<string, number>;
    latencies: Record<string, { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }>;
  } {
    const latencies: Record<
      string,
      { count: number; avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }
    > = {};
    for (const [key, hist] of this.histograms) {
      latencies[key] = {
        count: hist.count,
        avgMs: Math.round(hist.sumMs / hist.count),
        p50Ms: Math.round(this.percentile(hist.samples, 50)),
        p95Ms: Math.round(this.percentile(hist.samples, 95)),
        maxMs: Math.round(hist.maxMs),
      };
    }
    return { counters: Object.fromEntries(this.counters), latencies };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

export const metrics = new Metrics();
