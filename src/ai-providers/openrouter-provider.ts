import { BaseHttpProvider } from './base-provider.js';
import {
  isOpenRouterCircuitOpen,
  registerOpenRouterFailure,
  resetOpenRouterFailures,
} from '../openrouter-circuit.js';
import { GenerateParams, GenerateResult } from './types.js';

interface OpenRouterProviderOptions {
  apiKey: string;
  modelGeneral: string;
  modelCode: string;
  baseUrl: string;
}

export class OpenRouterProvider extends BaseHttpProvider {
  readonly name = 'openrouter';
  readonly model: string;

  constructor(private readonly options: OpenRouterProviderOptions) {
    super();
    this.model = options.modelGeneral;
  }

  isAvailable(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    if (isOpenRouterCircuitOpen()) {
      throw new Error('OpenRouter circuit is open');
    }

    const model = params.forceCodeModel
      ? this.options.modelCode
      : this.options.modelGeneral;

    try {
      const response = await this.chatCompletion(
        `${this.options.baseUrl}/chat/completions`,
        this.options.apiKey,
        model,
        [
          { role: 'system', content: params.systemPrompt },
          ...params.messages.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: params.prompt },
        ],
        {
          temperature: params.temperature ?? 0.2,
          timeoutMs: params.timeoutMs ?? 60_000,
        },
      );

      resetOpenRouterFailures();
      return {
        text: response.text,
        provider: this.name,
        model: response.model,
        latencyMs: response.latencyMs,
        tokensUsed: response.usage,
      };
    } catch (err) {
      registerOpenRouterFailure(
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }
}
