import { afterEach, describe, expect, it, vi } from 'vitest';

import { BaseHttpProvider } from './base-provider.js';
import { ChatMessage } from './types.js';

class TestProvider extends BaseHttpProvider {
  readonly name = 'test';
  readonly model = 'test-model';

  isAvailable(): boolean {
    return true;
  }

  async generate(): Promise<never> {
    throw new Error('Not used in this test');
  }

  async invoke(
    messages: ChatMessage[],
    opts: { timeoutMs?: number; temperature?: number } = {},
  ) {
    return this.chatCompletion(
      'https://api.example.com/chat/completions',
      'secret',
      this.model,
      messages,
      {
        timeoutMs: opts.timeoutMs ?? 50,
        temperature: opts.temperature ?? 0.2,
      },
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BaseHttpProvider.chatCompletion', () => {
  it('aborts on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );

    const provider = new TestProvider();
    await expect(provider.invoke([], { timeoutMs: 5 })).rejects.toThrow(
      /timeout/i,
    );
  });

  it('throws on non-ok HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      })),
    );

    const provider = new TestProvider();
    await expect(provider.invoke([])).rejects.toThrow(/HTTP 503/);
  });

  it('throws on malformed JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      })),
    );

    const provider = new TestProvider();
    await expect(provider.invoke([])).rejects.toThrow(/bad json/);
  });

  it('throws when response text is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          model: 'x',
          choices: [{ message: { content: '   ' } }],
        }),
      })),
    );

    const provider = new TestProvider();
    await expect(provider.invoke([])).rejects.toThrow(/empty response/i);
  });

  it('returns normalized text and usage on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          model: 'test-v2',
          choices: [
            {
              message: {
                content: [{ type: 'text', text: 'Hello' }, { text: ' world' }],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
      })),
    );

    const provider = new TestProvider();
    const result = await provider.invoke([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);

    expect(result.text).toBe('Hello world');
    expect(result.model).toBe('test-v2');
    expect(result.usage).toEqual({ prompt: 12, completion: 7 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
