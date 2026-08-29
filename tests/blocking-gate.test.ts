import { describe, expect, it } from 'vitest';
import { blockingGate, type JournalEntry } from '../src/database/decision-journal.js';

/**
 * Which gate stopped a decision.
 *
 * The property under test is not that the strings are pretty — it is that a
 * decision failing several gates at once reports the *earliest* one. An
 * operator told "score too low" about a WATCH will tune a threshold that was
 * never consulted, and nothing they do to it will ever change the outcome.
 */

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-08-25T10:00:00Z',
    signalId: 's1',
    expectedHorizon: '1-5d',
    eventId: 'e1',
    eventType: 'earnings',
    eventHeadline: 'A headline',
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

describe('blockingGate', () => {
  it('reports a filled decision as traded', () => {
    expect(blockingGate(entry({ order: { id: 'o1', status: 'filled', filledPrice: 200 } }))).toBe(
      'traded',
    );
  });

  it('names the empty asset, which is the case no threshold can fix', () => {
    expect(blockingGate(entry({ signal: 'WATCH', asset: 'NONE' }))).toBe(
      'model named no asset (WATCH/HOLD + NONE)',
    );
  });

  it('separates a declined call on a real asset from an empty one', () => {
    expect(blockingGate(entry({ signal: 'HOLD', asset: 'AAPL' }))).toBe('model declined (HOLD)');
  });

  it('reports the missing price rather than the missing risk verdict', () => {
    // Both are absent; only one of them is the cause.
    expect(blockingGate(entry({ riskDecision: null, priceAtSignal: null }))).toBe(
      'no price — no symbol resolved, or the quote failed',
    );
  });

  it('distinguishes a priced decision the engine never saw', () => {
    expect(blockingGate(entry({ riskDecision: null, priceAtSignal: 200 }))).toBe(
      'never evaluated (observation gate, or halted)',
    );
  });

  it('names the rules that fired when risk refused', () => {
    const refused = entry({
      riskDecision: { verdict: 'rejected', quantity: 0, notional: 0, rejections: ['min_score'] },
    });
    expect(blockingGate(refused)).toBe('risk refused: min_score');
  });

  it('still reports a refusal that carries no rule', () => {
    const refused = entry({
      riskDecision: { verdict: 'rejected', quantity: 0, notional: 0, rejections: [] },
    });
    expect(blockingGate(refused)).toBe('risk refused');
  });

  it('does not blame the score for a WATCH the engine never scored', () => {
    // The whole point of the ordering: this entry has a low score AND no risk
    // decision AND no price, but the model declining is what actually happened.
    const watch = entry({
      signal: 'WATCH',
      asset: 'NONE',
      score: 0.1,
      priceAtSignal: null,
      riskDecision: null,
    });
    expect(blockingGate(watch)).toBe('model named no asset (WATCH/HOLD + NONE)');
  });

  it('calls out an approved decision with no order, which is a fault not a refusal', () => {
    expect(blockingGate(entry())).toBe('approved but no order recorded');
  });
});
