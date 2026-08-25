import { type Clock, systemClock } from '../../core/clock.js';
import { sha256 } from '../../core/hash.js';
import { createLogger, type Logger } from '../../core/logger.js';
import type { NormalizedDocument } from '../../domain/types.js';
import { buildSignalTask, SIGNAL_SYSTEM_PROMPT, type MarketContext } from '../../intelligence/llm/prompt.js';
import type { LLMProvider } from '../../intelligence/llm/types.js';
import type { MarketEvent } from '../../intelligence/types.js';
import type { MarketRegime } from '../regime.js';
import { scoreSignal } from '../scoring/scorer.js';
import { LlmHypothesis, LLM_HYPOTHESIS_JSON_SCHEMA, type Signal } from './types.js';

/**
 * Signal generation: verified event -> LLM hypothesis -> scored signal.
 *
 * The model's output is schema-validated before anything reads it. A malformed
 * or refused response produces no signal at all — never a default one, because
 * a fabricated "HOLD, 0.5" would be indistinguishable from real analysis in the
 * decision journal.
 */

export interface GenerateOptions {
  event: MarketEvent;
  documents: NormalizedDocument[];
  context?: MarketContext;
  regime?: MarketRegime;
  historicalHitRate?: number;
  historicalSampleSize?: number;
  clock?: Clock;
  logger?: Logger;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Symbols an order could actually be placed on. Passed through to the prompt
   * so the model expresses a ticker-less story as a view on something
   * tradable instead of on "NONE".
   */
  tradableUniverse?: string[];
}

export interface GenerationResult {
  signal?: Signal;
  /** Why no signal was produced, when that is the outcome. */
  skipped?: string;
}

export class SignalGenerator {
  constructor(
    private readonly llm: LLMProvider,
    private readonly log: Logger = createLogger('signal-generator'),
  ) {}

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const clock = options.clock ?? systemClock;
    const { event } = options;

    if (!this.llm.isConfigured()) {
      return { skipped: 'no LLM provider configured' };
    }
    if (event.verification.status === 'contradicted') {
      // Cheaper and safer to stop here than to pay for analysis of a claim
      // somebody has already denied.
      return { skipped: 'event is contradicted' };
    }

    const documents = options.documents.map((doc) => ({
      source: doc.source,
      tier: doc.sourceTier,
      reliability: doc.source_reliability,
      title: doc.title,
      content: doc.content.slice(0, 3000),
    }));

    const task = buildSignalTask(event, documents, options.context, {
      ...(options.tradableUniverse ? { tradableUniverse: options.tradableUniverse } : {}),
    });

    let result;
    try {
      result = await this.llm.analyze<unknown>({
        schema: LLM_HYPOTHESIS_JSON_SCHEMA,
        system: SIGNAL_SYSTEM_PROMPT,
        // The task text already carries the fenced documents; passing an empty
        // second payload keeps the untrusted content in exactly one place.
        untrustedContent: '',
        task,
        ...(options.effort ? { effort: options.effort } : {}),
      });
    } catch (err) {
      this.log.warn({ eventId: event.id, error: (err as Error).message }, 'LLM analysis failed');
      return { skipped: `llm error: ${(err as Error).message}` };
    }

    if (result.refused) {
      return { skipped: `model declined (${result.refusalCategory ?? 'no category'})` };
    }

    const parsed = LlmHypothesis.safeParse(result.value);
    if (!parsed.success) {
      // Schema validation is the boundary: unvalidated model output never
      // reaches the strategy layer.
      this.log.warn(
        { eventId: event.id, issues: parsed.error.issues.map((i) => i.message) },
        'model output failed schema validation',
      );
      return { skipped: 'malformed model output' };
    }

    const hypothesis = parsed.data;
    const scoring = scoreSignal({
      event,
      hypothesis,
      ...(options.context?.recentReturnPct !== undefined
        ? { recentReturnPct: options.context.recentReturnPct }
        : {}),
      ...(options.context?.volumeRatio !== undefined ? { volumeRatio: options.context.volumeRatio } : {}),
      ...(options.context?.volatilityPct !== undefined
        ? { volatilityPct: options.context.volatilityPct }
        : {}),
      ...(options.regime ? { regime: options.regime } : {}),
      ...(options.historicalHitRate !== undefined
        ? { historicalHitRate: options.historicalHitRate }
        : {}),
      ...(options.historicalSampleSize !== undefined
        ? { historicalSampleSize: options.historicalSampleSize }
        : {}),
    });

    const createdAt = clock.now().toISOString();
    const signal: Signal = {
      id: sha256(`${event.id}|${hypothesis.asset}|${createdAt}`).slice(0, 24),
      createdAt,
      eventId: event.id,
      asset: hypothesis.asset.toUpperCase(),
      action: hypothesis.action,
      modelConfidence: hypothesis.confidence,
      score: scoring.score,
      expectedHorizon: hypothesis.expected_horizon,
      impact: hypothesis.impact,
      impactStrength: hypothesis.impact_strength,
      reason: hypothesis.reason,
      catalyst: hypothesis.catalyst,
      uncertainties: [
        ...hypothesis.uncertainties,
        // Score vetoes are uncertainties the operator must see, so they are
        // merged into the same field the dashboard renders.
        ...scoring.vetoes,
      ],
      likelyPricedIn: hypothesis.likely_priced_in,
      manipulationSuspected: hypothesis.manipulation_suspected,
      sources: event.sources,
      components: scoring.components,
      ...(options.context?.lastPrice !== undefined ? { priceAtSignal: options.context.lastPrice } : {}),
      provenance: {
        provider: this.llm.id,
        model: result.model,
        latencyMs: result.latencyMs,
        ...(result.usage.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: result.usage.estimatedCostUsd }
          : {}),
      },
    };

    if (hypothesis.manipulation_suspected) {
      this.log.warn(
        { eventId: event.id, sources: event.sources },
        'model reported an apparent instruction-injection attempt in source content',
      );
    }

    return { signal };
  }
}
