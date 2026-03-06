import { describe, expect, it, vi } from 'vitest';

import { HostRouter } from './host-router.js';
import { GenerateParams, GenerateResult, HostProvider } from './types.js';

function makeProvider(
  name: string,
  opts: {
    available?: boolean;
    result?: GenerateResult;
    error?: Error;
    onGenerate?: (params: GenerateParams) => void;
  } = {},
): HostProvider {
  return {
    name,
    model: `${name}-model`,
    isAvailable: () => opts.available ?? true,
    async generate(params: GenerateParams): Promise<GenerateResult> {
      opts.onGenerate?.(params);
      if (opts.error) throw opts.error;
      return (
        opts.result || {
          text: `${name} ok`,
          provider: name,
          model: `${name}-model`,
          latencyMs: 10,
        }
      );
    },
  };
}

describe('HostRouter', () => {
  it('returns primary provider result when primary succeeds', async () => {
    const providers = new Map<string, HostProvider>([
      ['openrouter', makeProvider('openrouter')],
      ['kimi', makeProvider('kimi')],
    ]);

    const router = new HostRouter({
      primary: 'openrouter',
      fallbackChain: ['kimi'],
      verbose: false,
      providers,
    });

    const result = await router.route({
      prompt: 'hello',
      messages: [],
      groupName: 'g',
      channelName: 'whatsapp',
    });

    expect(result?.provider).toBe('openrouter');
  });

  it('falls back when primary fails', async () => {
    const providers = new Map<string, HostProvider>([
      ['openrouter', makeProvider('openrouter', { error: new Error('boom') })],
      ['kimi', makeProvider('kimi')],
    ]);

    const router = new HostRouter({
      primary: 'openrouter',
      fallbackChain: ['kimi'],
      verbose: false,
      providers,
    });

    const result = await router.route({
      prompt: 'hello',
      messages: [],
      groupName: 'g',
      channelName: 'whatsapp',
    });

    expect(result?.provider).toBe('kimi');
  });

  it('returns null when all configured providers fail/unavailable', async () => {
    const providers = new Map<string, HostProvider>([
      ['openrouter', makeProvider('openrouter', { error: new Error('down') })],
      ['kimi', makeProvider('kimi', { available: false })],
    ]);

    const router = new HostRouter({
      primary: 'openrouter',
      fallbackChain: ['kimi'],
      verbose: false,
      providers,
    });

    const result = await router.route({
      prompt: 'hello',
      messages: [],
      groupName: 'g',
      channelName: 'whatsapp',
    });

    expect(result).toBeNull();
  });

  it('dedupes provider chain and skips unknown names', async () => {
    const openrouterGenerate = vi.fn(async () => ({
      text: 'ok',
      provider: 'openrouter',
      model: 'openrouter-model',
      latencyMs: 12,
    }));

    const providers = new Map<string, HostProvider>([
      [
        'openrouter',
        {
          name: 'openrouter',
          model: 'openrouter-model',
          isAvailable: () => true,
          generate: openrouterGenerate,
        },
      ],
    ]);

    const router = new HostRouter({
      primary: 'openrouter',
      fallbackChain: ['openrouter', 'unknown', 'openrouter'],
      verbose: false,
      providers,
    });

    const result = await router.route({
      prompt: 'hello',
      messages: [],
      groupName: 'g',
      channelName: 'whatsapp',
    });

    expect(result?.provider).toBe('openrouter');
    expect(openrouterGenerate).toHaveBeenCalledTimes(1);
  });

  it('propagates forceCodeModel to provider generate params', async () => {
    const onGenerate = vi.fn();
    const providers = new Map<string, HostProvider>([
      ['openrouter', makeProvider('openrouter', { onGenerate })],
    ]);
    const router = new HostRouter({
      primary: 'openrouter',
      fallbackChain: [],
      verbose: false,
      providers,
    });

    await router.route({
      prompt: 'write code',
      messages: [],
      groupName: 'g',
      channelName: 'whatsapp',
      forceCodeModel: true,
    });

    expect(onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ forceCodeModel: true }),
    );
  });
});
