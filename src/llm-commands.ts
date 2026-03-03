export type LlmCommand =
  | { type: 'help' }
  | { type: 'list-free-models' }
  | { type: 'debate'; prompt: string };

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

  return null;
}

export function llmCommandHelpText(): string {
  return [
    '*LLM commands*',
    '• /free-models (or *free-models): list current free OpenRouter models',
    '• /debate <prompt> (or *debate <prompt>): run multi-model critique/fight and return synthesis',
    '• /llm-help: show this help',
  ].join('\n');
}
