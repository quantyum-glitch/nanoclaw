import { describe, expect, it } from 'vitest';

import { parseLlmCommand } from './llm-commands.js';

const trigger = /^@Andy\b/i;

describe('parseLlmCommand', () => {
  it('parses slash free-models command', () => {
    expect(parseLlmCommand('/free-models', trigger)).toEqual({
      type: 'list-free-models',
    });
  });

  it('parses star debate command with prompt', () => {
    expect(parseLlmCommand('*debate compare options', trigger)).toEqual({
      type: 'debate',
      prompt: 'compare options',
    });
  });

  it('parses trigger-prefixed command', () => {
    expect(parseLlmCommand('@Andy /models', trigger)).toEqual({
      type: 'list-free-models',
    });
  });

  it('returns help for debate without prompt', () => {
    expect(parseLlmCommand('/debate', trigger)).toEqual({
      type: 'help',
    });
  });

  it('returns null for non-command text', () => {
    expect(parseLlmCommand('hello there', trigger)).toBeNull();
  });
});
