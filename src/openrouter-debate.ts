import { readEnvFile } from './env.js';

interface OpenRouterModelApi {
  id: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
    web_search?: string;
    internal_reasoning?: string;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelApi[];
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenRouterChoice {
  message?: { content?: string };
}

interface OpenRouterChatResponse {
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
}

interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  debateModels: string[];
  synthModel: string;
}

export interface OpenRouterChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterChatCallResult {
  model: string;
  content: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface FreeModel {
  id: string;
  contextLength: number;
}

export interface DebateRun {
  model: string;
  text: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface DebateResult {
  primary: DebateRun;
  critiques: DebateRun[];
  failedCritics: string[];
  synthesis: DebateRun;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

const DEFAULT_DEBATE_MODELS = [
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
  'google/gemma-3-27b-it:free',
];

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFreeModel(model: OpenRouterModelApi): boolean {
  if (model.id.includes(':free')) return true;
  if (!model.pricing) return false;

  const prices = [
    model.pricing.prompt,
    model.pricing.completion,
    model.pricing.request,
    model.pricing.image,
    model.pricing.web_search,
    model.pricing.internal_reasoning,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => toNumber(v));

  return prices.length > 0 && prices.every((p) => p === 0);
}

function loadOpenRouterConfig(requireApiKey: boolean): OpenRouterConfig {
  const env = readEnvFile([
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_DEBATE_MODELS',
    'OPENROUTER_SYNTH_MODEL',
  ]);

  const apiKey = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '';
  if (requireApiKey && !apiKey) {
    throw new Error('OPENROUTER_API_KEY is required.');
  }

  const baseUrl =
    process.env.OPENROUTER_BASE_URL ||
    env.OPENROUTER_BASE_URL ||
    'https://openrouter.ai/api/v1';

  const configuredModels = parseList(
    process.env.OPENROUTER_DEBATE_MODELS || env.OPENROUTER_DEBATE_MODELS,
  );
  const debateModels =
    configuredModels.length > 0 ? configuredModels : DEFAULT_DEBATE_MODELS;

  const synthModel =
    process.env.OPENROUTER_SYNTH_MODEL ||
    env.OPENROUTER_SYNTH_MODEL ||
    debateModels[0];

  return { apiKey, baseUrl, debateModels, synthModel };
}

export async function callOpenRouterChat(
  config: { apiKey: string; baseUrl: string },
  model: string,
  messages: OpenRouterChatMessage[],
  opts?: { timeoutMs?: number; temperature?: number },
): Promise<OpenRouterChatCallResult> {
  const startedAt = Date.now();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.3,
    }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 90_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${model} failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as OpenRouterChatResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error(`${model} returned empty content.`);
  }

  return {
    model,
    content,
    latencyMs: Date.now() - startedAt,
    promptTokens: payload.usage?.prompt_tokens || 0,
    completionTokens: payload.usage?.completion_tokens || 0,
  };
}

async function openRouterChat(
  config: OpenRouterConfig,
  model: string,
  messages: OpenRouterChatMessage[],
): Promise<DebateRun> {
  const result = await callOpenRouterChat(config, model, messages, {
    temperature: 0.3,
    timeoutMs: 90_000,
  });
  return {
    model: result.model,
    text: result.content,
    latencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

export async function listOpenRouterFreeModels(
  maxModels = 20,
): Promise<FreeModel[]> {
  const config = loadOpenRouterConfig(false);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(`${config.baseUrl}/models`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenRouter models API failed (${response.status}): ${text}`,
    );
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  const models = payload.data || [];
  return models
    .filter(isFreeModel)
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .slice(0, maxModels)
    .map((m) => ({
      id: m.id,
      contextLength: m.context_length || 0,
    }));
}

export async function runOpenRouterDebate(
  prompt: string,
): Promise<DebateResult> {
  const config = loadOpenRouterConfig(true);
  const primaryModel = config.debateModels[0];
  const criticModels = config.debateModels.slice(1);

  const primary = await openRouterChat(config, primaryModel, [
    {
      role: 'system',
      content:
        'You are the author. Provide a direct answer with assumptions, constraints, and a concrete recommendation.',
    },
    { role: 'user', content: prompt },
  ]);

  const critiques: DebateRun[] = [];
  const failedCritics: string[] = [];

  for (const criticModel of criticModels) {
    try {
      const critique = await openRouterChat(config, criticModel, [
        {
          role: 'system',
          content:
            'You are a critical reviewer. Find flaws, missing risks, and weak assumptions. Be concrete and adversarial but technical.',
        },
        {
          role: 'user',
          content: [
            `Original user request:\n${prompt}`,
            '',
            `Draft answer to review:\n${primary.text}`,
            '',
            'Return:',
            '1) What is wrong',
            '2) What is missing',
            '3) How to fix',
          ].join('\n'),
        },
      ]);
      critiques.push(critique);
    } catch {
      failedCritics.push(criticModel);
    }
  }

  const critiqueBlock =
    critiques.length > 0
      ? critiques
          .map((c, i) => `Critique ${i + 1} (${c.model}):\n${c.text}`)
          .join('\n\n')
      : 'No critic responses available.';

  const synthesis = await openRouterChat(config, config.synthModel, [
    {
      role: 'system',
      content:
        'You are the final judge. Merge valid critiques, reject bad critiques, and output the best final answer.',
    },
    {
      role: 'user',
      content: [
        `User request:\n${prompt}`,
        '',
        `Primary draft (${primary.model}):\n${primary.text}`,
        '',
        critiqueBlock,
        '',
        'Return the final answer only.',
      ].join('\n'),
    },
  ]);

  const allRuns = [primary, ...critiques, synthesis];
  return {
    primary,
    critiques,
    failedCritics,
    synthesis,
    totalPromptTokens: allRuns.reduce((acc, run) => acc + run.promptTokens, 0),
    totalCompletionTokens: allRuns.reduce(
      (acc, run) => acc + run.completionTokens,
      0,
    ),
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function formatFreeModelsMessage(models: FreeModel[]): string {
  if (models.length === 0) {
    return 'No free OpenRouter models found.';
  }

  const lines = ['*OpenRouter free models (top by context)*'];
  for (const model of models) {
    lines.push(`• ${model.id} (ctx=${model.contextLength})`);
  }

  const recommended = models
    .slice(0, 4)
    .map((m) => m.id)
    .join(',');
  if (recommended) {
    lines.push('');
    lines.push(`Suggested OPENROUTER_DEBATE_MODELS=${recommended}`);
  }

  return lines.join('\n');
}

export function formatDebateMessage(result: DebateResult): string {
  const lines = [
    '*Multi-model debate complete*',
    `• Primary: ${result.primary.model}`,
    `• Critics succeeded: ${result.critiques.length}`,
    `• Critics failed: ${result.failedCritics.length}`,
    `• Synthesis: ${result.synthesis.model}`,
    `• Total prompt tokens: ${result.totalPromptTokens}`,
    `• Total completion tokens: ${result.totalCompletionTokens}`,
    '',
    '*Final synthesis*',
    truncate(result.synthesis.text, 3200),
  ];

  if (result.failedCritics.length > 0) {
    lines.push('');
    lines.push(`Failed critics: ${result.failedCritics.join(', ')}`);
  }

  return lines.join('\n');
}
