export type LlmCommand =
  | { type: 'help' }
  | { type: 'list-free-models' }
  | { type: 'debate'; prompt: string }
  | { type: 'code'; prompt: string }
  | { type: 'agent'; prompt: string }
  | { type: 'twitter-summary' }
  | { type: 'twitter-refresh' };

function stripTriggerPrefix(content: string, triggerPattern: RegExp): string {
  const match = content.match(triggerPattern);
  if (!match || match.index !== 0) {
    return content.trim();
  }
  return content.slice(match[0].length).trim();
}

export function parseLlmCommand(
  content: string,
  triggerPattern: RegExp,
): LlmCommand | null {
  const stripped = stripTriggerPrefix(content, triggerPattern);
  const lower = stripped.toLowerCase().trim();

  // Support plain trigger phrases (without slash/star) for convenience.
  if (
    lower === 'twitter summary' ||
    lower === 'top tweets' ||
    lower === 'twitter list' ||
    lower === 'twitter'
  ) {
    return { type: 'twitter-summary' };
  }

  if (
    lower === 'twitter now' ||
    lower === 'twitter refresh' ||
    lower === 'twitter update'
  ) {
    return { type: 'twitter-refresh' };
  }

  const match = stripped.match(/^([/*])\s*([a-z0-9-]+)\b([\s\S]*)$/i);
  if (!match) return null;

  const command = match[2].toLowerCase();
  const rest = (match[3] || '').trim();

  if (command === 'llm-help' || command === 'brains-help') {
    return { type: 'help' };
  }

  if (
    command === 'free-models' ||
    command === 'models' ||
    command === 'openrouter-free'
  ) {
    return { type: 'list-free-models' };
  }

  if (command === 'debate' || command === 'fight' || command === 'critique') {
    if (!rest) return { type: 'help' };
    return { type: 'debate', prompt: rest };
  }

  if (command === 'code') {
    if (!rest) return { type: 'help' };
    return { type: 'code', prompt: rest };
  }

  if (command === 'agent') {
    if (!rest) return { type: 'help' };
    return { type: 'agent', prompt: rest };
  }

  if (
    command === 'twitter-summary' ||
    command === 'top-tweets' ||
    command === 'x-summary'
  ) {
    return { type: 'twitter-summary' };
  }

  if (command === 'twitter-now' || command === 'twitter-refresh') {
    return { type: 'twitter-refresh' };
  }

  if (command === 'twitter') {
    if (/^(now|refresh|update)\b/i.test(rest)) {
      return { type: 'twitter-refresh' };
    }
    return { type: 'twitter-summary' };
  }

  return null;
}

export function llmCommandHelpText(): string {
  return [
    '*LLM commands*',
    '- /free-models (or *free-models): list current free OpenRouter models',
    '- /debate <prompt> (or *debate <prompt>): run multi-model critique/fight and return synthesis',
    '- /code <prompt> (or *code <prompt>): run with the strong coding model',
    '- /agent <prompt> (or *agent <prompt>): bypass host router and run in container',
    '- /twitter-summary (or *top-tweets): show cached Twitter/X list summary',
    '- /twitter-now (or *twitter-refresh): refresh Twitter summary then show it',
    '- /llm-help: show this help',
  ].join('\n');
}
