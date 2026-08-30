import { describe, expect, it } from 'vitest';
import { blockingGate, blockingGateFr, type JournalEntry } from '../src/database/decision-journal.js';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  FUNNEL_STAGE_LABELS_FR,
  funnelReasonFr,
  summariseFunnelFr,
  type FunnelStep,
} from '../src/monitoring/cycle-funnel.js';

/**
 * The French the operator actually reads.
 *
 * The property worth pinning is not the wording — it is that French and
 * English never disagree about *which* gate stopped a decision. They share one
 * ordering (`blockingGateOf`); these tests hold them to it, so a future edit to
 * one language cannot quietly make the two dashboards tell different stories.
 */

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-08-29T10:00:00Z',
    signalId: 's1',
    expectedHorizon: '1-5d',
    eventId: 'e1',
    eventType: 'earnings',
    eventHeadline: 'Un titre',
    asset: 'AAPL',
    signal: 'BUY',
    modelConfidence: 0.7,
    score: 0.6,
    priceAtSignal: 200,
    verificationStatus: 'verified',
    verificationConfidence: 0.9,
    sources: ['outlet_a'],
    riskDecision: { verdict: 'approved', quantity: 5, notional: 1000, rejections: [] },
    order: null,
    outcome: null,
    ...overrides,
  } as JournalEntry;
}

describe('blockingGateFr', () => {
  it('names the empty asset as a missing company, not a missing field', () => {
    expect(blockingGateFr(entry({ signal: 'WATCH', asset: 'NONE' }))).toBe(
      'aucune action identifiable dans la nouvelle',
    );
  });

  it('translates the risk rules an operator can act on', () => {
    const refused = entry({
      riskDecision: { verdict: 'rejected', quantity: 0, notional: 0, rejections: ['min_score'] },
    });
    expect(blockingGateFr(refused)).toBe('refusé par le contrôle des risques : note trop faible');
  });

  it('passes an unknown rule through rather than inventing a translation', () => {
    const refused = entry({
      riskDecision: { verdict: 'rejected', quantity: 0, notional: 0, rejections: ['regle_future'] },
    });
    expect(blockingGateFr(refused)).toContain('regle_future');
  });

  it('agrees with the English version on which gate fired', () => {
    // Both read the same ordering, so every case must classify identically —
    // this is the guarantee, the wording is not.
    const cases: JournalEntry[] = [
      entry({ order: { id: 'o', status: 'filled' } }),
      entry({ signal: 'WATCH', asset: 'NONE' }),
      entry({ signal: 'HOLD', asset: 'AAPL' }),
      entry({ riskDecision: null, priceAtSignal: null }),
      entry({ riskDecision: null, priceAtSignal: 200 }),
      entry({ riskDecision: { verdict: 'rejected', quantity: 0, notional: 0, rejections: ['min_score'] } }),
      entry(),
    ];
    const en = cases.map(blockingGate);
    const fr = cases.map(blockingGateFr);
    expect(new Set(en).size).toBe(cases.length);
    expect(new Set(fr).size).toBe(cases.length);
  });

  it('calls an approved decision with no order an anomaly, not a refusal', () => {
    expect(blockingGateFr(entry())).toContain('anomalie');
  });
});

describe('French funnel labels', () => {
  it('covers every stage, so no row can fall back to English', () => {
    for (const stage of FUNNEL_STAGES) {
      expect(FUNNEL_STAGE_LABELS_FR[stage]).toBeTruthy();
      expect(FUNNEL_STAGE_LABELS_FR[stage]).not.toBe(FUNNEL_STAGE_LABELS[stage]);
    }
  });

  it('translates the reasons the pipeline emits', () => {
    expect(funnelReasonFr('contradicted')).toBe('démentis');
    expect(funnelReasonFr('not tradeable or halted')).toContain('pas d’action identifiable');
  });

  it('reads the number out of a reason that carries one', () => {
    expect(funnelReasonFr('materiality below 0.4')).toBe('importance sous 0.4');
    expect(funnelReasonFr('confidence below 0.5')).toBe('fiabilité sous 0.5');
  });

  it('leaves an unrecognised reason untouched', () => {
    // Better shown as written than dropped or mistranslated.
    expect(funnelReasonFr('quelque chose de nouveau')).toBe('quelque chose de nouveau');
  });
});

describe('summariseFunnelFr', () => {
  it('says where a cycle stopped and why', () => {
    const steps: FunnelStep[] = [
      { stage: 'ingest', count: 12 },
      { stage: 'events', count: 3 },
      { stage: 'analysis_gate', count: 0, reasons: { 'materiality below 0.4': 3 } },
    ];
    const summary = summariseFunnelFr(steps);
    expect(summary).toContain('3 événements détectés');
    expect(summary).toContain('importance sous 0.4');
  });

  it('reports a filled cycle plainly', () => {
    expect(summariseFunnelFr([{ stage: 'ingest', count: 4 }, { stage: 'orders', count: 1 }])).toBe(
      '1 ordre passé.',
    );
  });

  it('does not pretend a cycle ran when none did', () => {
    expect(summariseFunnelFr([])).toBe('Le cycle n’a pas démarré.');
  });

  it('keeps the reasons when a cycle dies at its very first step', () => {
    // No earlier step to compare against, so the reasons are the whole line —
    // dropping them would leave "nothing happened" with no cause attached.
    const summary = summariseFunnelFr([
      { stage: 'ingest', count: 0, reasons: { 'ingestion failed': 1 } },
    ]);
    expect(summary).toContain('échec de la récupération');
  });
});
