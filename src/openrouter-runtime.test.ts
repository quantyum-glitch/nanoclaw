import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _classifyOpenRouterFailureForTests,
  buildSystemPrompt,
  formatHistoryForFallbackPrompt,
} from './openrouter-runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildSystemPrompt', () => {
  it('includes assistant, channel rules, group name, and memory files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-openrouter-'));
    tempDirs.push(dir);

    const globalMemoryPath = path.join(dir, 'global.md');
    const groupMemoryPath = path.join(dir, 'group.md');
    fs.writeFileSync(globalMemoryPath, 'Global memory line', 'utf-8');
    fs.writeFileSync(groupMemoryPath, 'Group memory line', 'utf-8');

    const prompt = buildSystemPrompt({
      groupName: 'Family Chat',
      channelName: 'whatsapp',
      assistantName: 'Andy',
      globalMemoryPath,
      groupMemoryPath,
    });

    expect(prompt).toContain('You are Andy');
    expect(prompt).toContain('Formatting rules for WhatsApp');
    expect(prompt).toContain('Current group: Family Chat');
    expect(prompt).toContain('Global memory follows:');
    expect(prompt).toContain('Global memory line');
    expect(prompt).toContain('Group memory follows:');
    expect(prompt).toContain('Group memory line');
  });
});

describe('formatHistoryForFallbackPrompt', () => {
  it('formats chronological user and assistant context for Claude fallback', () => {
    const text = formatHistoryForFallbackPrompt([
      { role: 'user', content: 'Need a rollout plan.', timestamp: 't1' },
      { role: 'assistant', content: 'Here is a draft.', timestamp: 't2' },
    ]);

    expect(text).toContain('Previous conversation context:');
    expect(text).toContain('[User] Need a rollout plan.');
    expect(text).toContain('[Andy] Here is a draft.');
  });
});

describe('openrouter failure classification', () => {
  it('classifies parse/timeout/ratelimit/upstream/empty/network', () => {
    expect(
      _classifyOpenRouterFailureForTests(
        new SyntaxError('Unexpected token < in JSON at position 0'),
      ),
    ).toBe('parse');
    expect(_classifyOpenRouterFailureForTests(new Error('TimeoutError'))).toBe(
      'timeout',
    );
    expect(
      _classifyOpenRouterFailureForTests(new Error('model failed (429): busy')),
    ).toBe('rate_limit');
    expect(
      _classifyOpenRouterFailureForTests(new Error('model failed (503): down')),
    ).toBe('upstream');
    expect(
      _classifyOpenRouterFailureForTests(new Error('returned empty content.')),
    ).toBe('empty');
    expect(
      _classifyOpenRouterFailureForTests(new Error('model failed (400): bad')),
    ).toBe('network');
  });
});
