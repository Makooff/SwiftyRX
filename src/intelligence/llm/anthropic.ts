import Anthropic from '@anthropic-ai/sdk';
import { type Clock, systemClock } from '../../core/clock.js';
import { createLogger, type Logger } from '../../core/logger.js';
import { registerSecret } from '../../core/redact.js';
import type { AnalyzeOptions, LLMProvider, StructuredResult } from './types.js';
import { LLMSchemaError, LLMUnavailableError } from './types.js';

/**
 * Anthropic provider.
 *
 * Uses structured outputs (`output_config.format`) so the response is
 * schema-constrained at the API level rather than parsed hopefully from prose.
 *
 * Notes that shaped this implementation:
 *  - `temperature` / `top_p` / `top_k` are rejected by current models; steering
 *    is done through the prompt.
 *  - A request can come back with `stop_reason: "refusal"` and empty content.
 *    That is surfaced as `refused: true` and must be read as "no analysis",
 *    never as a bearish or neutral verdict.
 *  - The untrusted document text is passed as message content, and the
 *    operator's instructions as the system prompt — the only channel the model
 *    is told to obey.
 */

/** Published list prices, USD per million tokens. */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Minimal shape of the SDK call this provider makes.
 *
 * Narrower than the SDK's own signature on purpose: the provider only ever
 * makes one kind of non-streaming request, and a narrow seam keeps tests from
 * having to construct an `APIPromise`.
 */
export type MessagesCreateFn = (body: Record<string, unknown>) => Promise<unknown>;

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  clock?: Clock;
  logger?: Logger;
  /** Test seam: any object exposing a compatible `create`. */
  client?: { create: MessagesCreateFn };
  maxTokens?: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly model: string;

  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly defaultMaxTokens: number;
  private readonly apiKey?: string;
  private messages?: { create: MessagesCreateFn };

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? 'claude-opus-5';
    this.clock = options.clock ?? systemClock;
    this.log = options.logger ?? createLogger('llm-anthropic');
    this.defaultMaxTokens = options.maxTokens ?? 4096;

    if (options.client) {
      this.messages = options.client;
    } else if (options.apiKey) {
      this.apiKey = options.apiKey;
      registerSecret(options.apiKey);
      const sdk = new Anthropic({ apiKey: options.apiKey });
      this.messages = {
        create: (body) => sdk.messages.create(body as never) as Promise<unknown>,
      };
    }
  }

  isConfigured(): boolean {
    return this.messages !== undefined;
  }

  private estimateCost(inputTokens: number, outputTokens: number): number | undefined {
    const pricing = PRICING_PER_MTOK[this.model];
    if (!pricing) return undefined;
    return (inputTokens / 1e6) * pricing.input + (outputTokens / 1e6) * pricing.output;
  }

  async analyze<T>(options: AnalyzeOptions): Promise<StructuredResult<T>> {
    if (!this.messages) {
      throw new LLMUnavailableError('Anthropic provider is not configured (ANTHROPIC_API_KEY missing)');
    }

    const startedAt = this.clock.nowMs();

    // The untrusted payload rides in the user turn; the system prompt is the
    // only place operator instructions appear.
    const response = await this.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      system: options.system,
      output_config: {
        format: { type: 'json_schema', schema: options.schema },
        ...(options.effort ? { effort: options.effort } : {}),
      },
      messages: [
        {
          role: 'user',
          content: `${options.task}\n\n${options.untrustedContent}`,
        },
      ],
    });

    const latencyMs = this.clock.nowMs() - startedAt;
    const message = response as Anthropic.Message;

    const usage = {
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    };
    const estimatedCostUsd = this.estimateCost(usage.inputTokens, usage.outputTokens);

    // A refusal is a successful HTTP response with no analysis in it. Reading
    // `content[0]` here without checking would throw or, worse, silently
    // produce a neutral-looking result.
    if (message.stop_reason === 'refusal') {
      const category = (message as { stop_details?: { category?: string } }).stop_details?.category;
      this.log.warn({ category }, 'model declined to analyse this event');
      return {
        value: undefined as unknown as T,
        usage: { ...usage, ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}) },
        model: message.model ?? this.model,
        latencyMs,
        refused: true,
        ...(category ? { refusalCategory: category } : {}),
      };
    }

    const textBlock = message.content?.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );
    if (!textBlock) {
      throw new LLMSchemaError('Model returned no text content', message.content);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (err) {
      throw new LLMSchemaError(`Model output was not valid JSON: ${(err as Error).message}`, textBlock.text);
    }

    return {
      value: parsed as T,
      usage: { ...usage, ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}) },
      model: message.model ?? this.model,
      latencyMs,
    };
  }

  async health(): Promise<{ state: 'healthy' | 'degraded' | 'unavailable' | 'disabled'; detail?: string }> {
    if (!this.isConfigured()) {
      return { state: 'disabled', detail: 'ANTHROPIC_API_KEY not set' };
    }
    // Deliberately not probed: a health check that spends tokens on every
    // dashboard refresh is a recurring bill, not a diagnostic.
    return {
      state: 'healthy',
      detail: `configured for ${this.model} (not probed — probes cost tokens)`,
    };
  }

  /** Present so callers can assert the key never leaks into logs. */
  get hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }
}
