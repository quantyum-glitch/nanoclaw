import { BaseHttpProvider } from './base-provider.js';
import { GenerateParams, GenerateResult } from './types.js';

interface KimiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export class KimiProvider extends BaseHttpProvider {
  readonly name = 'kimi';
  readonly model: string;

  constructor(private readonly options: KimiProviderOptions) {
    super();
    this.model = options.model;
  }

  isAvailable(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async generate(params: GenerateParams): Promise<GenerateResult> {
    const response = await this.chatCompletion(
      `${this.options.baseUrl}/chat/completions`,
      this.options.apiKey,
      this.options.model,
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

    return {
      text: response.text,
      provider: this.name,
      model: response.model,
      latencyMs: response.latencyMs,
      tokensUsed: response.usage,
    };
  }
}
