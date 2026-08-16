/**
 * LLM provider abstraction.
 *
 * The system is not tied to one vendor or one model. Everything downstream
 * consumes `StructuredResult`, never a raw completion, so a provider swap
 * cannot change the shape of what the strategy layer sees.
 *
 * What the LLM is allowed to do here is deliberately narrow: read documents,
 * extract facts, propose a market hypothesis, and explain it. It does not size
 * positions, it does not decide whether to trade, and its confidence is an
 * input to scoring rather than a permission to act.
 */

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD when the provider's pricing is known. */
  estimatedCostUsd?: number;
}

export interface StructuredResult<T> {
  value: T;
  usage: LLMUsage;
  model: string;
  latencyMs: number;
  /**
   * Set when the provider declined to answer. The caller must treat this as
   * "no analysis", never as a neutral or negative verdict.
   */
  refused?: boolean;
  refusalCategory?: string;
}

export interface AnalyzeOptions {
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  /** Operator instructions. Never contains ingested content. */
  system: string;
  /**
   * The untrusted payload. Providers must present this to the model as data to
   * be analysed, never as instructions to be followed.
   */
  untrustedContent: string;
  /** The question being asked about that content. */
  task: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LLMProvider {
  readonly id: string;
  readonly model: string;
  isConfigured(): boolean;
  /** Returns a schema-validated object, or throws. */
  analyze<T>(options: AnalyzeOptions): Promise<StructuredResult<T>>;
  /** Cheap liveness probe. Must never throw. */
  health(): Promise<{ state: 'healthy' | 'degraded' | 'unavailable' | 'disabled'; detail?: string }>;
}

/** Raised when the model returns something the schema rejects. */
export class LLMSchemaError extends Error {
  constructor(
    message: string,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = 'LLMSchemaError';
  }
}

/** Raised when the provider is not configured or is switched off. */
export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}
