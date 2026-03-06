import {
  CRITICS_MODE,
  HOST_AI_VERBOSE,
  HOST_FALLBACK_CHAIN,
  KIMI_API_KEY,
  KIMI_BASE_URL,
  KIMI_MODEL,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_CODE,
  OPENROUTER_MODEL_GENERAL,
  PRIMARY_AI,
} from '../config.js';
import {
  buildRefactorPrompt,
  runCritics,
  shouldRunCritics,
} from '../critics/index.js';
import { logger } from '../logger.js';
import { ConversationWindowMessage, buildSystemPrompt } from '../openrouter-runtime.js';
import { KimiProvider } from './kimi-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { GenerateResult, HostProvider } from './types.js';

export interface HostRouteRequest {
  prompt: string;
  messages: ConversationWindowMessage[];
  groupName: string;
  channelName: string;
  groupMemoryPath?: string;
  globalMemoryPath?: string;
  assistantName?: string;
  forceCodeModel?: boolean;
}

interface HostRouterOptions {
  primary: string;
  fallbackChain: string[];
  verbose: boolean;
  criticsMode: typeof CRITICS_MODE;
  providers?: Map<string, HostProvider>;
}

function dedupeChain(primary: string, fallbacks: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const provider of [primary, ...fallbacks]) {
    const normalized = provider.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export class HostRouter {
  private readonly providerOrder: string[];
  private readonly providers: Map<string, HostProvider>;
  private readonly verbose: boolean;
  private readonly criticsMode: typeof CRITICS_MODE;

  constructor(options?: Partial<HostRouterOptions>) {
    this.providers = options?.providers || this.buildDefaultProviders();
    this.verbose = options?.verbose ?? HOST_AI_VERBOSE;
    this.criticsMode = options?.criticsMode ?? CRITICS_MODE;
    this.providerOrder = dedupeChain(
      options?.primary || PRIMARY_AI,
      options?.fallbackChain || HOST_FALLBACK_CHAIN,
    );
  }

  async route(request: HostRouteRequest): Promise<GenerateResult | null> {
    const systemPrompt = buildSystemPrompt({
      groupName: request.groupName,
      channelName: request.channelName,
      groupMemoryPath: request.groupMemoryPath,
      globalMemoryPath: request.globalMemoryPath,
      assistantName: request.assistantName,
    });

    for (const providerName of this.providerOrder) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        if (this.verbose) {
          logger.debug({ provider: providerName }, 'Host provider not found');
        }
        continue;
      }
      if (!provider.isAvailable()) {
        if (this.verbose) {
          logger.debug({ provider: providerName }, 'Host provider unavailable');
        }
        continue;
      }

      try {
        const draft = await provider.generate({
          prompt: request.prompt,
          messages: request.messages,
          systemPrompt,
          forceCodeModel: request.forceCodeModel,
        });
        const shouldCritique = shouldRunCritics(this.criticsMode, {
          isCodeRequest: Boolean(request.forceCodeModel),
          providerName: draft.provider,
          providerModel: draft.model,
        });
        const result = shouldCritique
          ? await this.refineWithCritics(provider, request, systemPrompt, draft)
          : draft;

        if (this.verbose) {
          logger.info(
            {
              provider: result.provider,
              model: result.model,
              latencyMs: result.latencyMs,
            },
            'Host provider succeeded',
          );
        }
        return result;
      } catch (err) {
        logger.warn(
          { provider: providerName, err },
          'Host provider failed, trying next',
        );
      }
    }

    return null;
  }

  private async refineWithCritics(
    provider: HostProvider,
    request: HostRouteRequest,
    systemPrompt: string,
    draft: GenerateResult,
  ): Promise<GenerateResult> {
    try {
      const critics = await runCritics(draft.text, request.prompt);
      if (critics.length === 0) return draft;

      const refinementPrompt = buildRefactorPrompt(
        request.prompt,
        draft.text,
        critics,
      );
      const refined = await provider.generate({
        prompt: refinementPrompt,
        messages: request.messages,
        systemPrompt,
        forceCodeModel: request.forceCodeModel,
      });

      if (this.verbose) {
        logger.info(
          {
            provider: draft.provider,
            criticCount: critics.length,
          },
          'Applied critic-guided refinement',
        );
      }

      return refined;
    } catch (err) {
      logger.warn(
        {
          provider: draft.provider,
          err: err instanceof Error ? err.message : String(err),
        },
        'Critic refinement failed, using draft',
      );
      return draft;
    }
  }

  private buildDefaultProviders(): Map<string, HostProvider> {
    return new Map<string, HostProvider>([
      [
        'openrouter',
        new OpenRouterProvider({
          apiKey: OPENROUTER_API_KEY,
          modelGeneral: OPENROUTER_MODEL_GENERAL,
          modelCode: OPENROUTER_MODEL_CODE,
          baseUrl: OPENROUTER_BASE_URL,
        }),
      ],
      [
        'kimi',
        new KimiProvider({
          apiKey: KIMI_API_KEY,
          model: KIMI_MODEL,
          baseUrl: KIMI_BASE_URL,
        }),
      ],
      [
        'openai',
        new OpenAIProvider({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_MODEL,
          baseUrl: OPENAI_BASE_URL,
        }),
      ],
    ]);
  }
}
