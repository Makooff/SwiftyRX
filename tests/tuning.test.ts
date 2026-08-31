import { describe, expect, it } from 'vitest';
import { applyToEnvFile, parseEnvFile } from '../src/config/env-file.js';
import type { JournalEntry } from '../src/database/decision-journal.js';
import {
  applyRefusal,
  bootstrapRecommendations,
  buildReport,
  classifyJournal,
  isTunable,
  measuredRecommendations,
  MIN_OUTCOMES_TO_RECOMMEND,
  recommendedScoreThreshold,
  TUNABLE_KEYS,
  type AppliedRecord,
  type DesiredSetting,
} from '../src/strategy/tuning.js';

/**
 * What the bot may decide about itself.
 *
 * The refusals are tested as properties rather than as messages: a message can
 * be reworded, and a test that pins one only proves the sentence still exists.
 * What must hold is that nothing is written — under the sample bar, for a key
 * outside the allowlist, or a second time on the same evidence.
 */

const NOW = new Date('2026-08-31T12:00:00Z');

/** `.env.recommande` carries a value and the French comment justifying it. */
function want(values: Record<string, string>): Record<string, DesiredSetting> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value, comment: `raison pour ${key}` }]),
  );
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: '2026-08-01T10:00:00Z',
    signalId: `sig-${Math.random()}`,
    expectedHorizon: 'days',
    eventId: 'evt',
    eventType: 'earnings',
    eventHeadline: 'headline',
    asset: 'AAPL',
    signal: 'BUY',
    modelConfidence: 0.7,
    score: 0.6,
    priceAtSignal: 100,
    verificationStatus: 'corroborated',
    verificationConfidence: 0.7,
    sources: ['outlet_a'],
    riskDecision: null,
    order: null,
    outcome: null,
    reasoning: { summary: '', catalyst: '', uncertainties: [], factors: [] },
    provenance: { model: 'test', promptVersion: '1', analysedAt: '2026-08-01T10:00:00Z' },
    ...overrides,
  } as JournalEntry;
}

function scored(count: number, correct: number, score = 0.6): JournalEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry({
      score,
      outcome: {
        evaluatedAt: '2026-08-05T10:00:00Z',
        priceAfter: 101,
        returnPct: 1,
        directionCorrect: i < correct,
        horizonDays: 3,
      },
    }),
  );
}

describe('the four states of the journal', () => {
  it('calls an empty journal empty', () => {
    expect(classifyJournal([], NOW)).toEqual({ kind: 'empty' });
  });

  it('does not count a decision that can never be scored', () => {
    // WATCH predicts no direction, and an entry with no entry price can never
    // be priced afterwards. Counting either as a "decision" would overstate
    // what is there, which is the one thing this module must not do.
    const useless = [entry({ signal: 'WATCH' }), entry({ priceAtSignal: null })];
    expect(classifyJournal(useless, NOW)).toEqual({ kind: 'empty' });
  });

  it('reports decisions awaiting a note', () => {
    const state = classifyJournal([entry(), entry()], NOW);
    expect(state.kind).toBe('no_outcomes');
    if (state.kind !== 'no_outcomes') throw new Error('unreachable');
    expect(state.decisions).toBe(2);
    // Horizon is long past, so both are ready to be priced.
    expect(state.duePending).toBe(2);
  });

  it('separates too few results from enough', () => {
    expect(classifyJournal(scored(29, 20), NOW).kind).toBe('too_few');
    expect(classifyJournal(scored(30, 20), NOW).kind).toBe('measured');
  });

  it('uses the same sample bar the scorer imposes on itself', () => {
    expect(MIN_OUTCOMES_TO_RECOMMEND).toBe(30);
  });
});

describe('the allowlist', () => {
  it('excludes every risk limit and permission', () => {
    for (const key of [
      'MAX_POSITION_PERCENT',
      'MAX_SINGLE_TRADE_RISK_PERCENT',
      'MAX_DAILY_LOSS_PERCENT',
      'MAX_LEVERAGE',
      'ALLOW_SHORT_SELLING',
      'ALLOW_CRYPTO',
      'ALLOW_OPTIONS',
      'REQUIRE_APPROVAL',
      'MODE',
      'ANTHROPIC_API_KEY',
      'ENABLE_X_INGESTION',
      'X_BEARER_TOKEN',
    ]) {
      expect(isTunable(key)).toBe(false);
    }
  });

  it('drops a forbidden key even when the recommended file asks for it', () => {
    // .env.recommande is a file on disk; treating it as trusted input is how a
    // "starting configuration" quietly becomes a way to raise the leverage.
    const recs = bootstrapRecommendations(
      want({ MAX_LEVERAGE: '10', ALLOW_SHORT_SELLING: 'true', MIN_SIGNAL_SCORE: '0.35' }),
      { MAX_LEVERAGE: '1', ALLOW_SHORT_SELLING: 'false', MIN_SIGNAL_SCORE: '0.55' },
    );
    expect(recs.map((r) => r.key)).toEqual(['MIN_SIGNAL_SCORE']);
  });

  it('recommends nothing for a value already set', () => {
    expect(bootstrapRecommendations(want({ LLM_EFFORT: 'high' }), { LLM_EFFORT: 'high' })).toEqual([]);
  });

  it('only ever names keys from the allowlist', () => {
    const report = buildReport([], {}, want({ MIN_SIGNAL_SCORE: '0.35', MAX_LEVERAGE: '5' }), NOW);
    for (const rec of report.recommendations) expect(TUNABLE_KEYS).toContain(rec.key);
  });
});

describe('the score threshold, from outcomes only', () => {
  it('says nothing when nothing has been scored', () => {
    expect(recommendedScoreThreshold([entry(), entry()])).toBeUndefined();
  });

  it('finds the lowest bar that clears the target hit rate', () => {
    // Below 0.5 the decisions were wrong; at 0.5 and above they were right.
    const bad = scored(20, 0, 0.35);
    const good = scored(20, 20, 0.55);
    const best = recommendedScoreThreshold([...bad, ...good]);
    expect(best).toBeDefined();
    expect(best!.threshold).toBeGreaterThan(0.35);
    expect(best!.threshold).toBeLessThanOrEqual(0.55);
    expect(best!.hitRate).toBeGreaterThanOrEqual(0.55);
  });

  it('refuses to invent a bar when no threshold separates anything', () => {
    // Uniformly wrong at every score: there is no bar that fixes this, and
    // returning one would be fitting noise.
    expect(recommendedScoreThreshold(scored(40, 0, 0.6))).toBeUndefined();
  });

  it('ignores activity entirely — only what the market did counts', () => {
    // The failure this whole module guards against: a system that lowers its
    // own bar because it has not traded much. Two journals with the same
    // outcomes but wildly different volumes of unscored activity must yield
    // the same recommendation.
    const outcomes = [...scored(20, 0, 0.35), ...scored(20, 20, 0.55)];
    const withNoise = [...outcomes, ...Array.from({ length: 500 }, () => entry({ score: 0.1 }))];
    expect(recommendedScoreThreshold(withNoise)).toEqual(recommendedScoreThreshold(outcomes));
  });
});

describe('when --apply must refuse', () => {
  const desired = want({ MIN_SIGNAL_SCORE: '0.35' });
  const current = { MIN_SIGNAL_SCORE: '0.55' };

  it('allows the starting configuration once', () => {
    const report = buildReport([], current, desired, NOW);
    expect(report.basis).toBe('bootstrap');
    expect(applyRefusal(report, undefined)).toBeUndefined();
  });

  it('refuses to apply the starting configuration twice', () => {
    const report = buildReport([], current, desired, NOW);
    const applied: AppliedRecord = {
      appliedAt: '2026-08-20T00:00:00Z',
      basis: 'bootstrap',
      outcomes: 0,
      keys: ['MIN_SIGNAL_SCORE'],
    };
    expect(applyRefusal(report, applied)).toBeDefined();
  });

  it('refuses when there is nothing to change', () => {
    const report = buildReport([], { MIN_SIGNAL_SCORE: '0.35' }, desired, NOW);
    expect(report.recommendations).toEqual([]);
    expect(applyRefusal(report, undefined)).toBeDefined();
  });

  it('refuses a second measured application on the same evidence', () => {
    const entries = [...scored(20, 0, 0.35), ...scored(20, 20, 0.55)];
    const report = buildReport(entries, { MIN_SIGNAL_SCORE: '0.9' }, desired, NOW);
    expect(report.basis).toBe('measured');
    expect(report.recommendations).toHaveLength(1);

    const sameEvidence: AppliedRecord = {
      appliedAt: '2026-08-25T00:00:00Z',
      basis: 'measured',
      outcomes: 40,
      keys: ['MIN_SIGNAL_SCORE'],
    };
    expect(applyRefusal(report, sameEvidence)).toBeDefined();

    // One more scored decision, and it may speak again.
    expect(applyRefusal(report, { ...sameEvidence, outcomes: 39 })).toBeUndefined();
  });

  it('stops recommending the starting values once measurement takes over', () => {
    // 30 scored decisions switch the basis. The hand-picked values must not
    // still be offered alongside measured ones, or the bot would be arguing
    // with itself in one report.
    const report = buildReport(scored(30, 25, 0.6), current, desired, NOW);
    expect(report.basis).toBe('measured');
    expect(report.recommendations.every((rec) => rec.why.includes('mesurees'))).toBe(true);
  });
});

describe('measured recommendations', () => {
  it('says nothing when the configured bar is already right', () => {
    const entries = [...scored(20, 0, 0.35), ...scored(20, 20, 0.55)];
    const best = recommendedScoreThreshold(entries)!;
    expect(measuredRecommendations(entries, { MIN_SIGNAL_SCORE: String(best.threshold) })).toEqual([]);
  });
});

describe('editing a .env without destroying it', () => {
  const file = [
    '# Le seuil de score',
    '# Une deuxieme ligne de commentaire',
    'MIN_SIGNAL_SCORE=0.55',
    '',
    'MAX_LEVERAGE=1',
    '',
  ].join('\n');

  it('reads assignments and ignores comments', () => {
    expect(parseEnvFile(file)).toEqual({ MIN_SIGNAL_SCORE: '0.55', MAX_LEVERAGE: '1' });
  });

  it('strips surrounding quotes', () => {
    expect(parseEnvFile('A="one"\nB=\'two\'\nC=three')).toEqual({ A: 'one', B: 'two', C: 'three' });
  });

  it('replaces a value in place, keeping the comment above it', () => {
    const out = applyToEnvFile(file, { MIN_SIGNAL_SCORE: '0.35' });
    expect(out).toContain('# Le seuil de score\n# Une deuxieme ligne de commentaire\nMIN_SIGNAL_SCORE=0.35');
    expect(out).toContain('MAX_LEVERAGE=1');
  });

  it('appends a missing key under a heading rather than scattering it', () => {
    const out = applyToEnvFile(file, { LLM_EFFORT: 'high' }, '# --- ecrit par tune ---');
    expect(out).toContain('# --- ecrit par tune ---\nLLM_EFFORT=high');
    expect(parseEnvFile(out).LLM_EFFORT).toBe('high');
  });

  it('never uncomments a line somebody deliberately disabled', () => {
    const disabled = '# ENABLED_SOURCES=all\n';
    const out = applyToEnvFile(disabled, { ENABLED_SOURCES: 'all' }, '# written');
    expect(out).toContain('# ENABLED_SOURCES=all');
    expect(out).toContain('# written\nENABLED_SOURCES=all');
  });

  it('leaves every other line byte-for-byte', () => {
    const out = applyToEnvFile(file, { MIN_SIGNAL_SCORE: '0.35' });
    const before = file.split('\n').filter((l) => !l.startsWith('MIN_SIGNAL_SCORE'));
    const after = out.split('\n').filter((l) => !l.startsWith('MIN_SIGNAL_SCORE'));
    expect(after).toEqual(before);
  });
});
