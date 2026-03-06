import {
  CRITICS_MAX_MODELS,
  CRITICS_MODE,
  CRITICS_TIMEOUT_MS,
  CriticsMode,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_CRITIC_MODELS,
} from '../config.js';
import { logger } from '../logger.js';
import { callOpenRouterChat } from '../openrouter-debate.js';

const DEFAULT_CRITIC_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
];

const PAID_PROVIDER_NAMES = new Set(['kimi', 'openai']);

export interface CriticResult {
  model: string;
  critique: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface CriticDecisionInput {
  isCodeRequest: boolean;
  providerName: string;
  providerModel?: string;
}

interface RunCriticsOptions {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  maxModels?: number;
  timeoutMs?: number;
}

function modelLooksPaid(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes(':free')) return false;
  return normalized !== 'openrouter/free';
}

function resolveCriticModels(
  modelsOverride?: string[],
  maxModelsOverride?: number,
): string[] {
  const configured =
    modelsOverride && modelsOverride.length > 0
      ? modelsOverride
      : OPENROUTER_CRITIC_MODELS.length > 0
        ? OPENROUTER_CRITIC_MODELS
        : DEFAULT_CRITIC_MODELS;
  const capped = Math.max(1, maxModelsOverride ?? CRITICS_MAX_MODELS);
  return configured
    .map((model) => model.trim())
    .filter(Boolean)
    .slice(0, capped);
}

export function shouldRunCritics(
  mode: CriticsMode,
  input: CriticDecisionInput,
): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'code-only':
      return input.isCodeRequest;
    case 'paid':
      return (
        PAID_PROVIDER_NAMES.has(input.providerName) ||
        modelLooksPaid(input.providerModel)
      );
    case 'always':
      return true;
    default:
      return false;
  }
}

export async function runCritics(
  draft: string,
  originalPrompt: string,
  options?: RunCriticsOptions,
): Promise<CriticResult[]> {
  const apiKey = options?.apiKey ?? OPENROUTER_API_KEY;
  if (!apiKey) return [];

  const models = resolveCriticModels(options?.models, options?.maxModels);
  if (models.length === 0) return [];

  const timeoutMs = Math.max(5_000, options?.timeoutMs ?? CRITICS_TIMEOUT_MS);
  const baseUrl = options?.baseUrl ?? OPENROUTER_BASE_URL;
  const config = { apiKey, baseUrl };

  const tasks = models.map(async (model) => {
    const result = await callOpenRouterChat(
      config,
      model,
      [
        {
          role: 'system',
          content:
            'You are a critical reviewer. Find concrete flaws, edge cases, and stronger alternatives. Be concise.',
        },
        {
          role: 'user',
          content: [
            `Original request:\n${originalPrompt}`,
            '',
            `Draft response:\n${draft}`,
            '',
            'Return a short list of specific improvements.',
          ].join('\n'),
        },
      ],
      { timeoutMs, temperature: 0.2 },
    );

    return {
      model: result.model,
      critique: result.content,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    };
  });

  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter((entry) => entry.status === 'rejected');
  if (failures.length > 0) {
    logger.warn(
      { failedCritics: failures.length, totalCritics: settled.length },
      'One or more critics failed',
    );
  }

  return settled
    .filter(
      (entry): entry is PromiseFulfilledResult<CriticResult> =>
        entry.status === 'fulfilled',
    )
    .map((entry) => entry.value);
}

export function buildRefactorPrompt(
  originalPrompt: string,
  draft: string,
  critics: CriticResult[],
): string {
  const critiquesText = critics
    .map(
      (critic) =>
        `Critic (${critic.model}):\n${critic.critique.trim() || 'No feedback.'}`,
    )
    .join('\n\n');

  return [
    `Original request:\n${originalPrompt}`,
    '',
    `Current draft:\n${draft}`,
    '',
    'Critic feedback:',
    critiquesText || 'No critic feedback provided.',
    '',
    'Rewrite the answer to address valid critique points. Return only the improved final response.',
  ].join('\n');
}

export function getConfiguredCriticsMode(): CriticsMode {
  return CRITICS_MODE;
}
