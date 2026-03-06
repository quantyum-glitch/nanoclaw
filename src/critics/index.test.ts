import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRefactorPrompt,
  runCritics,
  shouldRunCritics,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shouldRunCritics', () => {
  it('handles each critics mode correctly', () => {
    expect(
      shouldRunCritics('off', {
        isCodeRequest: false,
        providerName: 'kimi',
      }),
    ).toBe(false);
    expect(
      shouldRunCritics('code-only', {
        isCodeRequest: true,
        providerName: 'openrouter',
      }),
    ).toBe(true);
    expect(
      shouldRunCritics('code-only', {
        isCodeRequest: false,
        providerName: 'openrouter',
      }),
    ).toBe(false);
    expect(
      shouldRunCritics('paid', {
        isCodeRequest: false,
        providerName: 'kimi',
      }),
    ).toBe(true);
    expect(
      shouldRunCritics('paid', {
        isCodeRequest: false,
        providerName: 'openrouter',
        providerModel: 'openrouter/free',
      }),
    ).toBe(false);
    expect(
      shouldRunCritics('paid', {
        isCodeRequest: false,
        providerName: 'openrouter',
        providerModel: 'openrouter/anthropic/claude-sonnet-4-5',
      }),
    ).toBe(true);
    expect(
      shouldRunCritics('always', {
        isCodeRequest: false,
        providerName: 'openrouter',
      }),
    ).toBe(true);
  });
});

describe('runCritics', () => {
  it('returns empty when no API key is provided', async () => {
    const result = await runCritics('draft', 'prompt', {
      apiKey: '',
      models: ['meta-llama/llama-3.3-70b-instruct:free'],
    });
    expect(result).toEqual([]);
  });

  it('returns only successful critic responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            model: 'm1',
            choices: [{ message: { content: 'Fix edge case A' } }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => 'unavailable',
        }),
    );

    const result = await runCritics('draft', 'prompt', {
      apiKey: 'key',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['model-a', 'model-b'],
      timeoutMs: 5000,
      maxModels: 2,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        model: 'model-a',
        critique: 'Fix edge case A',
      }),
    );
  });
});

describe('buildRefactorPrompt', () => {
  it('includes original request, draft, and all critiques', () => {
    const text = buildRefactorPrompt('orig', 'draft', [
      {
        model: 'm1',
        critique: 'Improve structure',
        latencyMs: 10,
        promptTokens: 1,
        completionTokens: 2,
      },
      {
        model: 'm2',
        critique: 'Handle error path',
        latencyMs: 20,
        promptTokens: 3,
        completionTokens: 4,
      },
    ]);

    expect(text).toContain('Original request:\norig');
    expect(text).toContain('Current draft:\ndraft');
    expect(text).toContain('Critic (m1):');
    expect(text).toContain('Critic (m2):');
  });
});
