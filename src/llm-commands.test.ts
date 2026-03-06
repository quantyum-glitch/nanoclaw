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

  it('parses code command with prompt', () => {
    expect(parseLlmCommand('/code write a migration script', trigger)).toEqual({
      type: 'code',
      prompt: 'write a migration script',
    });
  });

  it('parses agent command with prompt', () => {
    expect(parseLlmCommand('/agent run deep investigation', trigger)).toEqual({
      type: 'agent',
      prompt: 'run deep investigation',
    });
    expect(parseLlmCommand('*agent check all logs', trigger)).toEqual({
      type: 'agent',
      prompt: 'check all logs',
    });
  });

  it('parses twitter summary command variants', () => {
    expect(parseLlmCommand('/twitter-summary', trigger)).toEqual({
      type: 'twitter-summary',
    });
    expect(parseLlmCommand('*top-tweets', trigger)).toEqual({
      type: 'twitter-summary',
    });
    expect(parseLlmCommand('@Andy twitter summary', trigger)).toEqual({
      type: 'twitter-summary',
    });
  });

  it('parses twitter refresh command variants', () => {
    expect(parseLlmCommand('/twitter-now', trigger)).toEqual({
      type: 'twitter-refresh',
    });
    expect(parseLlmCommand('*twitter-refresh', trigger)).toEqual({
      type: 'twitter-refresh',
    });
    expect(parseLlmCommand('@Andy twitter now', trigger)).toEqual({
      type: 'twitter-refresh',
    });
  });

  it('returns null for non-command text', () => {
    expect(parseLlmCommand('hello there', trigger)).toBeNull();
  });
});
