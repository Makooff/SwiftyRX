import { describe, expect, it } from 'vitest';
import {
  CycleFunnelBuilder,
  CycleFunnelHistory,
  summariseFunnel,
  type CycleFunnel,
} from '../src/monitoring/cycle-funnel.js';

describe('CycleFunnelBuilder', () => {
  it('accumulates only the steps actually recorded, in order', () => {
    const builder = new CycleFunnelBuilder(3, '2026-08-18T12:00:00.000Z');
    builder.step('ingest', 5);
    builder.step('events', 2);
    const funnel = builder.finish('2026-08-18T12:00:01.000Z');

    expect(funnel.cycleId).toBe(3);
    expect(funnel.startedAt).toBe('2026-08-18T12:00:00.000Z');
    expect(funnel.finishedAt).toBe('2026-08-18T12:00:01.000Z');
    expect(funnel.steps.map((s) => s.stage)).toEqual(['ingest', 'events']);
    // A cycle stopped at events never asked about the analysis gate — the
    // step must be absent, not present with a zero.
    expect(funnel.steps.some((s) => s.stage === 'analysis_gate')).toBe(false);
  });

  it('omits reasons entirely when the reasons object is empty', () => {
    const builder = new CycleFunnelBuilder(1, '2026-08-18T12:00:00.000Z');
    builder.step('ingest', 5, {});
    const funnel = builder.finish('2026-08-18T12:00:01.000Z');
    expect(funnel.steps[0]).toEqual({ stage: 'ingest', count: 5 });
  });

  it('keeps reasons when present', () => {
    const builder = new CycleFunnelBuilder(1, '2026-08-18T12:00:00.000Z');
    builder.step('analysis_gate', 0, { 'materiality below 0.4': 10, 'confidence below 0.5': 2 });
    const funnel = builder.finish('2026-08-18T12:00:01.000Z');
    expect(funnel.steps[0]!.reasons).toEqual({ 'materiality below 0.4': 10, 'confidence below 0.5': 2 });
  });
});

describe('summariseFunnel', () => {
  it('says a cycle with no steps did not start', () => {
    expect(summariseFunnel([])).toBe('Cycle did not start.');
  });

  it('names the reasons when the very first stage dropped everything', () => {
    const summary = summariseFunnel([{ stage: 'ingest', count: 0 }]);
    expect(summary).toBe('Documents ingested: none.');
  });

  it('describes a drop with its reasons, matching the funnel this feature was requested over', () => {
    const summary = summariseFunnel([
      { stage: 'events', count: 12 },
      { stage: 'analysis_gate', count: 0, reasons: { 'materiality below 0.4': 10, 'confidence below 0.5': 2 } },
    ]);
    expect(summary).toBe(
      '12 events detected → 0 passed analysis gate — 10 materiality below 0.4, 2 confidence below 0.5.',
    );
  });

  it('reports a placed order as the terminal, successful case', () => {
    const summary = summariseFunnel([
      { stage: 'ingest', count: 3 },
      { stage: 'orders', count: 1 },
    ]);
    expect(summary).toBe('1 order(s) placed.');
  });

  it('names where a non-empty cycle stopped short of orders', () => {
    const summary = summariseFunnel([
      { stage: 'ingest', count: 3 },
      { stage: 'events', count: 2 },
      { stage: 'analysis_gate', count: 1 },
    ]);
    expect(summary).toBe('passed analysis gate: 1 — cycle ended here.');
  });
});

describe('CycleFunnelHistory', () => {
  const funnel = (cycleId: number): CycleFunnel => ({
    cycleId,
    startedAt: `2026-08-18T12:00:0${cycleId}.000Z`,
    finishedAt: `2026-08-18T12:00:0${cycleId}.500Z`,
    steps: [{ stage: 'ingest', count: cycleId }],
    summary: `cycle ${cycleId}`,
  });

  it('returns cycles newest first', () => {
    const history = new CycleFunnelHistory();
    history.record(funnel(1));
    history.record(funnel(2));
    expect(history.recent().map((f) => f.cycleId)).toEqual([2, 1]);
    expect(history.latest?.cycleId).toBe(2);
  });

  it('evicts the oldest cycle once capacity is exceeded', () => {
    const history = new CycleFunnelHistory({ capacity: 2 });
    history.record(funnel(1));
    history.record(funnel(2));
    history.record(funnel(3));
    expect(history.size).toBe(2);
    expect(history.recent().map((f) => f.cycleId)).toEqual([3, 2]);
  });

  it('recent() respects the requested limit', () => {
    const history = new CycleFunnelHistory();
    for (let i = 1; i <= 5; i += 1) history.record(funnel(i));
    expect(history.recent(2).map((f) => f.cycleId)).toEqual([5, 4]);
  });
});
