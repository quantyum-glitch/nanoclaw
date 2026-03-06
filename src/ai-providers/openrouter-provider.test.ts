import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPENROUTER_FAILURE_THRESHOLD } from '../config.js';
import {
  _getOpenRouterCircuitStateForTests,
  _registerOpenRouterFailureForTests,
  _resetOpenRouterCircuitForTests,
} from '../openrouter-circuit.js';
import { OpenRouterProvider } from './openrouter-provider.js';

function createProvider(): OpenRouterProvider {
  return new OpenRouterProvider({
    apiKey: 'or-key',
    modelGeneral: 'openrouter/general',
    modelCode: 'openrouter/code',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
}

beforeEach(() => {
  _resetOpenRouterCircuitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenRouterProvider', () => {
  it('short-circuits when circuit is already open', async () => {
    for (let i = 0; i < OPENROUTER_FAILURE_THRESHOLD; i += 1) {
      _registerOpenRouterFailureForTests('fail');
    }

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = createProvider();
    await expect(
      provider.generate({
        prompt: 'hello',
        messages: [],
        systemPrompt: 'sys',
      }),
    ).rejects.toThrow(/circuit is open/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers failure when HTTP request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'upstream down',
      })),
    );

    const provider = createProvider();
    await expect(
      provider.generate({
        prompt: 'hello',
        messages: [],
        systemPrompt: 'sys',
      }),
    ).rejects.toThrow(/HTTP 500/);

    const state = _getOpenRouterCircuitStateForTests();
    expect(state.failures).toBe(1);
  });

  it('resets failure state on successful response', async () => {
    _registerOpenRouterFailureForTests('temporary');

    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      json: async () => ({
        model: 'openrouter/general',
        choices: [{ message: { content: 'Hello there' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createProvider();
    const result = await provider.generate({
      prompt: 'hello',
      messages: [],
      systemPrompt: 'sys',
      forceCodeModel: true,
    });

    const state = _getOpenRouterCircuitStateForTests();
    expect(state).toEqual({ failures: 0, openUntil: 0 });
    expect(result.model).toBe('openrouter/general');

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit?];
    const body = JSON.parse(String(firstCall[1]?.body));
    expect(body.model).toBe('openrouter/code');
  });
});
