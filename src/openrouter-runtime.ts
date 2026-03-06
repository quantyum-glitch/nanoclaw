import fs from 'fs';

import {
  ASSISTANT_NAME,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_CODE,
  OPENROUTER_MODEL_GENERAL,
} from './config.js';
import { logger } from './logger.js';
import {
  callOpenRouterChat,
  OpenRouterChatMessage,
} from './openrouter-debate.js';

export interface ConversationWindowMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type OpenRouterFailureKind =
  | 'config'
  | 'timeout'
  | 'rate_limit'
  | 'upstream'
  | 'empty'
  | 'parse'
  | 'network'
  | 'unknown';

export class OpenRouterReplyError extends Error {
  kind: OpenRouterFailureKind;

  constructor(kind: OpenRouterFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface OpenRouterReplyRequest {
  groupName: string;
  channelName: string;
  history: ConversationWindowMessage[];
  promptOverride?: string;
  forceCodeModel?: boolean;
  groupMemoryPath?: string;
  globalMemoryPath?: string;
}

export interface OpenRouterReplyResult {
  model: string;
  text: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

function readMemoryFile(
  filePath: string | undefined,
  maxChars: number,
): string {
  if (!filePath || !fs.existsSync(filePath)) return '';
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[truncated]`;
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to read memory file for OpenRouter');
    return '';
  }
}

export function buildSystemPrompt(input: {
  groupName: string;
  channelName: string;
  groupMemoryPath?: string;
  globalMemoryPath?: string;
  assistantName?: string;
}): string {
  const assistantName = input.assistantName || ASSISTANT_NAME;
  const globalMemory = readMemoryFile(input.globalMemoryPath, 2000);
  const groupMemory = readMemoryFile(input.groupMemoryPath, 2000);

  const lines = [
    `You are ${assistantName}, a personal assistant replying in ${input.channelName}.`,
    'Write concise, directly useful replies.',
    'Never reveal internal reasoning or chain-of-thought.',
    'Do not include <internal> tags.',
    'If missing critical details, ask one short clarifying question.',
  ];

  if (input.channelName === 'whatsapp') {
    lines.push(
      'Formatting rules for WhatsApp: avoid markdown headings, keep output plain-text friendly, and use short bullets when helpful.',
    );
  }

  if (input.channelName === 'gmail') {
    lines.push(
      'Formatting rules for Gmail: write clean plain text with clear structure and no decorative markdown.',
    );
  }

  lines.push(`Current group: ${input.groupName}`);

  if (globalMemory) {
    lines.push('Global memory follows:');
    lines.push(globalMemory);
  }

  if (groupMemory) {
    lines.push('Group memory follows:');
    lines.push(groupMemory);
  }

  return lines.join('\n\n');
}

function normalizeModelText(content: string): string {
  return content.replace(/<internal>[\s\S]*?<\/internal>/gi, '').trim();
}

function toFailureKind(err: unknown): OpenRouterFailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err instanceof SyntaxError ||
    /json|parse|unexpected token/i.test(message)
  ) {
    return 'parse';
  }
  const statusMatch = message.match(/\((\d{3})\)/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'upstream';
    if (status >= 400) return 'network';
  }

  if (/timeout|aborted|AbortError|TimeoutError/i.test(message)) {
    return 'timeout';
  }

  if (/empty content/i.test(message)) return 'empty';
  return 'unknown';
}

/** @internal - exported for testing */
export function _classifyOpenRouterFailureForTests(
  err: unknown,
): OpenRouterFailureKind {
  return toFailureKind(err);
}

function buildMessages(
  systemPrompt: string,
  history: ConversationWindowMessage[],
  promptOverride?: string,
): OpenRouterChatMessage[] {
  const messages: OpenRouterChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const item of history) {
    messages.push({
      role: item.role,
      content: item.content,
    });
  }

  if (promptOverride) {
    messages.push({ role: 'user', content: promptOverride });
  }

  return messages;
}

export function formatHistoryForFallbackPrompt(
  history: ConversationWindowMessage[],
): string {
  if (history.length === 0) return '';
  const lines = ['Previous conversation context:'];
  for (const item of history) {
    const roleLabel = item.role === 'assistant' ? ASSISTANT_NAME : 'User';
    lines.push(`[${roleLabel}] ${item.content}`);
  }
  return lines.join('\n');
}

export async function runOpenRouterReply(
  request: OpenRouterReplyRequest,
): Promise<OpenRouterReplyResult> {
  if (!OPENROUTER_API_KEY) {
    throw new OpenRouterReplyError(
      'config',
      'OPENROUTER_API_KEY is not configured.',
    );
  }

  const model = request.forceCodeModel
    ? OPENROUTER_MODEL_CODE
    : OPENROUTER_MODEL_GENERAL;
  const systemPrompt = buildSystemPrompt({
    groupName: request.groupName,
    channelName: request.channelName,
    groupMemoryPath: request.groupMemoryPath,
    globalMemoryPath: request.globalMemoryPath,
  });

  try {
    const response = await callOpenRouterChat(
      {
        apiKey: OPENROUTER_API_KEY,
        baseUrl: OPENROUTER_BASE_URL,
      },
      model,
      buildMessages(systemPrompt, request.history, request.promptOverride),
      { timeoutMs: 60_000, temperature: 0.2 },
    );

    const text = normalizeModelText(response.content);
    if (!text) {
      throw new OpenRouterReplyError('empty', `${model} returned empty text.`);
    }

    return {
      model,
      text,
      latencyMs: response.latencyMs,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
    };
  } catch (err) {
    if (err instanceof OpenRouterReplyError) throw err;
    throw new OpenRouterReplyError(
      toFailureKind(err),
      err instanceof Error ? err.message : String(err),
    );
  }
}
