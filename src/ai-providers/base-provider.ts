import { ChatMessage, HostProvider } from './types.js';

interface ChatCompletionResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: { prompt: number; completion: number };
}

interface ChatCompletionOptions {
  temperature: number;
  timeoutMs: number;
}

interface OpenAICompatibleResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export abstract class BaseHttpProvider implements HostProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract isAvailable(): boolean;
  abstract generate(
    params: import('./types.js').GenerateParams,
  ): Promise<import('./types.js').GenerateResult>;

  protected async chatCompletion(
    endpoint: string,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    opts: ChatCompletionOptions,
  ): Promise<ChatCompletionResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `${this.name} HTTP ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as OpenAICompatibleResponse;
      const text = this.extractText(payload.choices?.[0]?.message?.content);
      if (!text) {
        throw new Error(`${this.name} returned empty response`);
      }

      return {
        text,
        model: payload.model || model,
        latencyMs: Date.now() - startedAt,
        usage: {
          prompt: payload.usage?.prompt_tokens || 0,
          completion: payload.usage?.completion_tokens || 0,
        },
      };
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || /abort|timeout/i.test(err.message))
      ) {
        throw new Error(`${this.name} timeout after ${opts.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractText(
    content: string | Array<{ type?: string; text?: string }> | undefined,
  ): string {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => item.text || '')
        .join('')
        .trim();
    }
    return '';
  }
}
