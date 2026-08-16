import type { AnalyzeOptions, LLMProvider, StructuredResult } from './types.js';
import { LLMUnavailableError } from './types.js';

/**
 * The provider used when no LLM is configured.
 *
 * It refuses rather than returning a neutral placeholder. A stub that quietly
 * answered "HOLD, confidence 0.5" would let the whole pipeline run and look
 * healthy while producing analysis nobody performed.
 */
export class NullLLMProvider implements LLMProvider {
  readonly id = 'none';
  readonly model = 'none';

  isConfigured(): boolean {
    return false;
  }

  async analyze<T>(_options: AnalyzeOptions): Promise<StructuredResult<T>> {
    throw new LLMUnavailableError(
      'No LLM provider configured. Set LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY to enable analysis.',
    );
  }

  async health(): Promise<{ state: 'disabled'; detail: string }> {
    return { state: 'disabled', detail: 'LLM_PROVIDER=none' };
  }
}
