import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import {
  canUseGemini,
  canUseKimi,
  canUseOpenRouter,
  callAnthropic,
  callGemini,
  callKimi,
  callOpenRouter,
  getDefaultModels,
  hasEnv,
} from './providers.js';
import {
  Blocker,
  CriticParseResult,
  StructuralCheck,
  dedupeBlockers,
  getBlockingBlockers,
  parseCriticMarkdownTable,
  structuralRubric,
  trimApproxTokens,
} from './rubric.js';

export type DebateMode = 'default' | 'review' | 'debate' | 'yolo';
export type PipelineStatus =
  | 'DRAFT_ONLY'
  | 'REVIEWED'
  | 'UNREVIEWED'
  | 'FAILED_BLOCKER'
  | 'ESCALATION_REQUIRED'
  | 'FAILED_EXPENSIVE'
  | 'ERROR';

export const EXIT_CODES = {
  success: 0,
  failedBlocker: 10,
  escalationRequired: 11,
  failedExpensive: 12,
  providerConfig: 13,
} as const;

const LIMITS = {
  draftTokens: 4000,
  critiqueSummaryTokens: 800,
  perCallTimeoutMs: 90_000,
  tier12BudgetMs: 5 * 60_000,
  tier3BudgetMs: 8 * 60_000,
} as const;

export interface PipelineInput {
  goal: string;
  mode: DebateMode;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  maxRounds: number;
}

export interface CriticRun {
  critic: string;
  provider: string;
  model: string;
  tier: 1 | 2 | 3;
  available: boolean;
  structured: boolean;
  timedOut: boolean;
  parse: CriticParseResult;
  raw: string;
  error?: string;
}

export interface PipelineDecision {
  status: PipelineStatus;
  mode: DebateMode;
  goal: string;
  maxRounds: number;
  roundsUsed: number;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  tiersUsed: number[];
  degraded: boolean;
  unresolvedBlocking: Blocker[];
  structural: StructuralCheck;
  critics: CriticRun[];
  notes: string[];
  callCounts: Record<string, number>;
  timingMs: {
    total: number;
    tier12: number;
    tier3: number;
  };
}

export interface PipelineResult {
  status: PipelineStatus;
  exitCode: number;
  spec: string;
  postImplementationReview: string;
  decision: PipelineDecision;
}

interface DraftResult {
  text: string;
  provider: string;
  model: string;
}

function buildDraftPrompt(goal: string): string {
  return [
    'You are writing an implementation specification for a software engineer.',
    `Goal: ${goal}`,
    '',
    'Output markdown with these required sections:',
    '## Summary',
    '## Architecture',
    '## Implementation Changes',
    '## Test Plan',
    '## Risks',
    '',
    'Be concrete and implementation-focused. Include explicit tradeoffs and failure modes.',
  ].join('\n');
}

function buildRewritePrompt(goal: string, currentSpec: string, critique: string): string {
  return [
    'Revise the implementation spec based on reviewer feedback.',
    `Goal: ${goal}`,
    '',
    'Current spec:',
    currentSpec,
    '',
    'Reviewer feedback summary:',
    critique,
    '',
    'Return markdown with required sections:',
    '## Summary',
    '## Architecture',
    '## Implementation Changes',
    '## Test Plan',
    '## Risks',
    '',
    'Resolve all BLOCKING issues where possible.',
  ].join('\n');
}

function buildCriticPrompt(
  goal: string,
  spec: string,
  criticFocus: string,
): string {
  return [
    'Review this implementation spec. Return ONLY this format:',
    '| ID | Severity | Description | Fix |',
    '|:---|:---|:---|:---|',
    '| B1 | BLOCKING | ... | ... |',
    'ASSESSMENT: BLOCKING',
    '',
    `Focus: ${criticFocus}`,
    `Goal: ${goal}`,
    '',
    'Rules:',
    '- Replace ASSESSMENT with exactly one value: CLEAN or MINOR or BLOCKING.',
    '- Use BLOCKING only for issues that would likely cause failure, data loss, severe security risk, or incorrect architecture.',
    '- Use MINOR for non-blocking improvements.',
    '- If no issues, keep only the header + separator rows and write ASSESSMENT: CLEAN.',
    '',
    'Spec:',
    spec,
  ].join('\n');
}

function summarizeCritique(raw: string): string {
  return trimApproxTokens(raw, LIMITS.critiqueSummaryTokens);
}

function toReviewMarkdown(run: CriticRun): string {
  if (!run.available) {
    return `### ${run.critic}\n- Status: unavailable\n- Error: ${run.error || 'n/a'}\n`;
  }
  if (!run.structured) {
    return `### ${run.critic}\n- Status: UNSTRUCTURED (excluded from blocker merge)\n- Raw:\n\n${run.raw}\n`;
  }
  return `### ${run.critic}\n${run.raw}\n`;
}

async function promptTier3Approval(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      'Tier 3 will use Sonnet + Opus (higher cost). Proceed? [y/N]: ',
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function computeExitCode(status: PipelineStatus): number {
  switch (status) {
    case 'FAILED_BLOCKER':
      return EXIT_CODES.failedBlocker;
    case 'ESCALATION_REQUIRED':
      return EXIT_CODES.escalationRequired;
    case 'FAILED_EXPENSIVE':
      return EXIT_CODES.failedExpensive;
    case 'ERROR':
      return EXIT_CODES.providerConfig;
    default:
      return EXIT_CODES.success;
  }
}

function initDecision(input: PipelineInput): PipelineDecision {
  return {
    status: 'ERROR',
    mode: input.mode,
    goal: input.goal,
    maxRounds: input.maxRounds,
    roundsUsed: 0,
    tierLimit: input.tierLimit,
    allowTier3: input.allowTier3,
    tiersUsed: [],
    degraded: false,
    unresolvedBlocking: [],
    structural: {
      hasSummary: false,
      hasArchitectureOrApproach: false,
      hasTestsOrAcceptance: false,
      hasRisks: false,
      passed: false,
      missing: [],
    },
    critics: [],
    notes: [],
    callCounts: {},
    timingMs: {
      total: 0,
      tier12: 0,
      tier3: 0,
    },
  };
}

function registerCall(decision: PipelineDecision, key: string): void {
  decision.callCounts[key] = (decision.callCounts[key] || 0) + 1;
}

function markTier(decision: PipelineDecision, tier: 1 | 2 | 3): void {
  if (!decision.tiersUsed.includes(tier)) decision.tiersUsed.push(tier);
}

async function generateDraftWithFallback(
  decision: PipelineDecision,
  models: ReturnType<typeof getDefaultModels>,
  prompt: string,
  stage: 'draft' | 'rewrite' | 'codex-rewrite',
): Promise<DraftResult> {
  const errors: string[] = [];
  const canOpenRouter = canUseOpenRouter();
  const attempts: Array<{
    label: string;
    invoke: () => Promise<DraftResult>;
  }> = [];

  if (canUseGemini()) {
    attempts.push({
      label: 'gemini',
      invoke: async () => {
        registerCall(decision, `gemini:${stage}`);
        const result = await callGemini(prompt, {
          maxOutputTokens: LIMITS.draftTokens,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.2,
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
        };
      },
    });
  }

  if (canOpenRouter) {
    attempts.push({
      label: 'openrouter',
      invoke: async () => {
        registerCall(decision, `openrouter:${stage}:${models.freeDrafter}`);
        const result = await callOpenRouter([{ role: 'user', content: prompt }], {
          model: models.freeDrafter,
          maxOutputTokens: LIMITS.draftTokens,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.2,
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
        };
      },
    });
  }

  if (canUseKimi()) {
    attempts.push({
      label: 'kimi',
      invoke: async () => {
        registerCall(decision, `kimi:${stage}`);
        const result = await callKimi(prompt, {
          maxOutputTokens: LIMITS.draftTokens,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.2,
        });
        return {
          text: result.text,
          provider: result.provider,
          model: result.model,
        };
      },
    });
  }

  if (attempts.length === 0) {
    throw new Error(
      'No draft provider available. Configure Gemini, OpenRouter, or Kimi provider (API key and/or CLI mode).',
    );
  }

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const draft = await attempt.invoke();
      if (i > 0) {
        decision.degraded = true;
        decision.notes.push(
          `${stage} used fallback provider ${draft.provider}/${draft.model} after prior provider failure.`,
        );
      }
      return draft;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.label}: ${message}`);
      decision.notes.push(`${stage} provider ${attempt.label} failed: ${message}`);
    }
  }

  throw new Error(`All draft providers failed for ${stage}. ${errors.join(' | ')}`);
}

async function runCritic(
  decision: PipelineDecision,
  config: {
    critic: string;
    provider: string;
    model: string;
    tier: 1 | 2 | 3;
    prompt: string;
    invoke: () => Promise<string>;
  },
): Promise<CriticRun> {
  try {
    registerCall(decision, `${config.provider}:${config.model}`);
    const raw = (await config.invoke()).trim();
    const parse = parseCriticMarkdownTable(raw);
    const run: CriticRun = {
      critic: config.critic,
      provider: config.provider,
      model: config.model,
      tier: config.tier,
      available: true,
      structured: parse.structured,
      timedOut: false,
      parse,
      raw,
      error: parse.error,
    };
    if (!parse.structured) {
      decision.degraded = true;
      decision.notes.push(
        `${config.critic} returned unstructured output; excluded from blocker merge.`,
      );
    } else if (parse.error) {
      decision.notes.push(`${config.critic}: ${parse.error}`);
    }
    decision.critics.push(run);
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(message);
    const run: CriticRun = {
      critic: config.critic,
      provider: config.provider,
      model: config.model,
      tier: config.tier,
      available: false,
      structured: false,
      timedOut,
      parse: {
        assessment: 'UNSTRUCTURED',
        blockers: [],
        structured: false,
        error: message,
      },
      raw: '',
      error: message,
    };
    decision.degraded = true;
    decision.notes.push(`${config.critic} unavailable: ${message}`);
    decision.critics.push(run);
    return run;
  }
}

function collectBlocking(critics: CriticRun[]): Blocker[] {
  const blocking = critics
    .filter((c) => c.available && c.structured)
    .flatMap((c) => getBlockingBlockers(c.parse.blockers));
  return dedupeBlockers(blocking);
}

function bothUnavailable(critics: CriticRun[]): boolean {
  return critics.every((c) => !c.available);
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const start = Date.now();
  const decision = initDecision(input);
  const models = getDefaultModels();
  let finalSpec = '';
  let postReview = '';

  try {
    const initialDraft = await generateDraftWithFallback(
      decision,
      models,
      buildDraftPrompt(input.goal),
      'draft',
    );
    finalSpec = trimApproxTokens(initialDraft.text, LIMITS.draftTokens);
    decision.structural = structuralRubric(finalSpec);
    decision.notes.push(
      `Initial draft model: ${initialDraft.provider}/${initialDraft.model}`,
    );

    if (input.mode === 'default' || input.mode === 'yolo') {
      decision.status = 'DRAFT_ONLY';
      if (!decision.structural.passed) {
        decision.notes.push(
          `Structural rubric missing: ${decision.structural.missing.join(', ')}`,
        );
      }
      postReview = `Mode: ${input.mode}. No critic pass executed. Human review required before implementation.`;
      const end = Date.now();
      decision.timingMs.total = end - start;
      decision.timingMs.tier12 = end - start;
      return {
        status: decision.status,
        exitCode: computeExitCode(decision.status),
        spec: finalSpec,
        postImplementationReview: postReview,
        decision,
      };
    }

    const tier12Start = Date.now();
    let unresolved: Blocker[] = [];
    let roundsUsed = 0;
    let unreviewed = false;

    for (let round = 1; round <= input.maxRounds; round += 1) {
      roundsUsed = round;
      if (Date.now() - tier12Start > LIMITS.tier12BudgetMs) {
        decision.notes.push('Tier 1+2 budget exhausted.');
        break;
      }

      const criticTasks: Array<Promise<CriticRun>> = [];
      const canOpenRouter = canUseOpenRouter();
      const canKimi = canUseKimi();

      if (canOpenRouter) {
        markTier(decision, 1);
        const prompt = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Architecture and implementation feasibility blockers only.',
        );
        criticTasks.push(
          runCritic(decision, {
            critic: 'FreeCritic',
            provider: 'openrouter',
            model: models.freeCritic,
            tier: 1,
            prompt,
            invoke: async () => {
              const response = await callOpenRouter(
                [{ role: 'user', content: prompt }],
                {
                  model: models.freeCritic,
                  maxOutputTokens: 1000,
                  timeoutMs: LIMITS.perCallTimeoutMs,
                },
              );
              return response.text;
            },
          }),
        );
      }

      if (
        input.mode === 'review' &&
        !canOpenRouter &&
        input.tierLimit >= 2 &&
        canKimi
      ) {
        markTier(decision, 2);
        const prompt = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Architecture, security, and edge-case blockers.',
        );
        criticTasks.push(
          runCritic(decision, {
            critic: 'KimiCritic',
            provider: 'kimi',
            model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
            tier: 2,
            prompt,
            invoke: async () => {
              const response = await callKimi(prompt, {
                maxOutputTokens: 1000,
                timeoutMs: LIMITS.perCallTimeoutMs,
                temperature: 0.2,
              });
              return response.text;
            },
          }),
        );
      }

      if (input.mode === 'debate' && input.tierLimit >= 2 && canKimi) {
        markTier(decision, 2);
        const prompt = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Security, edge cases, and reliability blockers.',
        );
        criticTasks.push(
          runCritic(decision, {
            critic: 'KimiCritic',
            provider: 'kimi',
            model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
            tier: 2,
            prompt,
            invoke: async () => {
              const response = await callKimi(prompt, {
                maxOutputTokens: 1000,
                timeoutMs: LIMITS.perCallTimeoutMs,
                temperature: 0.2,
              });
              return response.text;
            },
          }),
        );
      }

      let critics = await Promise.all(criticTasks);
      const hasStructuredCritic = critics.some((c) => c.available && c.structured);
      if (
        input.mode === 'review' &&
        input.tierLimit >= 2 &&
        canKimi &&
        !hasStructuredCritic &&
        !critics.some((c) => c.critic === 'KimiCritic')
      ) {
        markTier(decision, 2);
        decision.notes.push(
          'Review mode fallback: running Kimi critic because primary critic was unavailable/unstructured.',
        );
        const prompt = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Architecture, security, and edge-case blockers.',
        );
        const kimiFallback = await runCritic(decision, {
          critic: 'KimiCritic',
          provider: 'kimi',
          model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
          tier: 2,
          prompt,
          invoke: async () => {
            const response = await callKimi(prompt, {
              maxOutputTokens: 1000,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature: 0.2,
            });
            return response.text;
          },
        });
        critics = [...critics, kimiFallback];
      }
      if (critics.length === 0 || bothUnavailable(critics)) {
        unreviewed = true;
        decision.degraded = true;
        decision.notes.push(
          'All critics unavailable. Returning UNREVIEWED draft with warning banner.',
        );
        break;
      }

      unresolved = collectBlocking(critics);
      decision.structural = structuralRubric(finalSpec);
      if (unresolved.length === 0 && decision.structural.passed) {
        break;
      }
      if (round >= input.maxRounds) {
        break;
      }

      const critiqueSummaries = critics
        .filter((c) => c.available)
        .map((c) => `### ${c.critic}\n${summarizeCritique(c.raw)}`)
        .join('\n\n');

      const rewrite = await generateDraftWithFallback(
        decision,
        models,
        buildRewritePrompt(input.goal, finalSpec, critiqueSummaries),
        'rewrite',
      );
      finalSpec = trimApproxTokens(rewrite.text, LIMITS.draftTokens);
    }

    decision.roundsUsed = roundsUsed;
    decision.unresolvedBlocking = unresolved;

    if (unreviewed) {
      decision.status = 'UNREVIEWED';
      postReview = 'Critics unavailable. Treat this plan as unreviewed.';
    } else if (unresolved.length > 0 || !decision.structural.passed) {
      if (
        input.allowTier3 &&
        input.tierLimit >= 3 &&
        hasEnv('ANTHROPIC_API_KEY')
      ) {
        const approved = await promptTier3Approval();
        if (!approved) {
          decision.status = 'ESCALATION_REQUIRED';
          decision.notes.push('Tier 3 escalation was declined.');
          postReview =
            'Escalation required for unresolved blockers. Tier 3 not approved.';
        } else {
          const tier3Start = Date.now();
          markTier(decision, 3);
          registerCall(decision, `anthropic:${models.sonnet}`);
          const sonnetRewrite = await callAnthropic(
            buildRewritePrompt(
              input.goal,
              finalSpec,
              unresolved
                .map((b) => `- ${b.id} (${b.severity}): ${b.description} -> ${b.fix}`)
                .join('\n'),
            ),
            {
              model: models.sonnet,
              maxOutputTokens: LIMITS.draftTokens,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature: 0.2,
            },
          );
          finalSpec = trimApproxTokens(sonnetRewrite.text, LIMITS.draftTokens);

          const opusPrompt = buildCriticPrompt(
            input.goal,
            finalSpec,
            'Blocking architectural and security flaws only.',
          );
          registerCall(decision, `anthropic:${models.opus}`);
          const opusCritic = await runCritic(decision, {
            critic: 'OpusCritic',
            provider: 'anthropic',
            model: models.opus,
            tier: 3,
            prompt: opusPrompt,
            invoke: async () => {
              const response = await callAnthropic(opusPrompt, {
                model: models.opus,
                maxOutputTokens: 1000,
                timeoutMs: LIMITS.perCallTimeoutMs,
                temperature: 0.1,
              });
              return response.text;
            },
          });

          const opusBlocking = getBlockingBlockers(opusCritic.parse.blockers);
          if (opusBlocking.length > 0) {
            decision.status = 'FAILED_EXPENSIVE';
            decision.unresolvedBlocking = opusBlocking;
            postReview = toReviewMarkdown(opusCritic);
          } else {
            decision.status = 'REVIEWED';
            postReview = toReviewMarkdown(opusCritic);
          }
          decision.timingMs.tier3 = Date.now() - tier3Start;
          if (decision.timingMs.tier3 > LIMITS.tier3BudgetMs) {
            decision.notes.push('Tier 3 exceeded target time budget.');
          }
        }
      } else {
        decision.status = input.allowTier3 ? 'ESCALATION_REQUIRED' : 'FAILED_BLOCKER';
        if (decision.status === 'ESCALATION_REQUIRED') {
          decision.notes.push(
            'Tier 3 requested but unavailable (missing key or tier-limit < 3).',
          );
        }
        postReview = unresolved
          .map((b) => `- ${b.id} (${b.severity}): ${b.description} -> ${b.fix}`)
          .join('\n');
      }
    } else {
      decision.status = 'REVIEWED';
      postReview = 'Review loop passed with no unresolved blocking issues.';
    }

    if (input.mode === 'debate' && decision.status !== 'FAILED_EXPENSIVE') {
      const sections: string[] = [];
      if (input.tierLimit >= 2 && canUseOpenRouter()) {
        markTier(decision, 2);
        const codexPrompt = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Implementation feasibility, test gaps, and migration risks.',
        );
        const codexCritic = await runCritic(decision, {
          critic: 'CodexFinalCritic',
          provider: 'openrouter',
          model: models.codexCritic,
          tier: 2,
          prompt: codexPrompt,
          invoke: async () => {
            const response = await callOpenRouter(
              [{ role: 'user', content: codexPrompt }],
              {
                model: models.codexCritic,
                maxOutputTokens: 1200,
                timeoutMs: LIMITS.perCallTimeoutMs,
                temperature: 0.1,
              },
            );
            return response.text;
          },
        });
        sections.push('### Codex Final Critic', codexCritic.raw || '(no output)');

        if (codexCritic.available && codexCritic.structured) {
          const codexBlocking = getBlockingBlockers(codexCritic.parse.blockers);
          if (codexBlocking.length > 0) {
            const codexSummary = summarizeCritique(codexCritic.raw);
            const rewrite = await generateDraftWithFallback(
              decision,
              models,
              buildRewritePrompt(input.goal, finalSpec, codexSummary),
              'codex-rewrite',
            );
            finalSpec = trimApproxTokens(rewrite.text, LIMITS.draftTokens);
            sections.push(
              'Codex reported BLOCKING issues; draft was revised before rebound check.',
            );
          }
        }

        const reboundTasks: Array<Promise<CriticRun>> = [];
        const reboundPromptFree = buildCriticPrompt(
          input.goal,
          finalSpec,
          'Rebound check for remaining blockers after codex-informed revision.',
        );
        reboundTasks.push(
          runCritic(decision, {
            critic: 'FreeCriticRebound',
            provider: 'openrouter',
            model: models.freeCritic,
            tier: 1,
            prompt: reboundPromptFree,
            invoke: async () => {
              const response = await callOpenRouter(
                [{ role: 'user', content: reboundPromptFree }],
                {
                  model: models.freeCritic,
                  maxOutputTokens: 1000,
                  timeoutMs: LIMITS.perCallTimeoutMs,
                },
              );
              return response.text;
            },
          }),
        );
        if (canUseKimi()) {
          const reboundPromptKimi = buildCriticPrompt(
            input.goal,
            finalSpec,
            'Rebound check with focus on security and edge conditions.',
          );
          reboundTasks.push(
            runCritic(decision, {
              critic: 'KimiRebound',
              provider: 'kimi',
              model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
              tier: 2,
              prompt: reboundPromptKimi,
              invoke: async () => {
                const response = await callKimi(reboundPromptKimi, {
                  maxOutputTokens: 1000,
                  timeoutMs: LIMITS.perCallTimeoutMs,
                });
                return response.text;
              },
            }),
          );
        }
        const reboundRuns = await Promise.all(reboundTasks);
        const reboundBlocking = collectBlocking(reboundRuns);
        if (reboundBlocking.length > 0) {
          decision.notes.push(
            `Rebound check found ${reboundBlocking.length} remaining blocking issue(s). Human decision required.`,
          );
        }
        sections.push(
          ...reboundRuns.map((run) => toReviewMarkdown(run)),
          reboundBlocking.length > 0
            ? `Remaining BLOCKING issues after rebound:\n${reboundBlocking
                .map((b) => `- ${b.id}: ${b.description} -> ${b.fix}`)
                .join('\n')}`
            : 'Rebound check found no BLOCKING issues.',
        );
      } else {
        sections.push(
          'Codex final critic skipped (tier-limit < 2 or OpenRouter credentials missing).',
        );
      }
      postReview = [postReview, sections.join('\n\n')].filter(Boolean).join('\n\n');
    }

    const end = Date.now();
    decision.timingMs.total = end - start;
    decision.timingMs.tier12 = end - tier12Start;

    return {
      status: decision.status,
      exitCode: computeExitCode(decision.status),
      spec: finalSpec,
      postImplementationReview: postReview,
      decision,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision.status = 'ERROR';
    decision.notes.push(`Pipeline error: ${message}`);
    decision.timingMs.total = Date.now() - start;
    return {
      status: 'ERROR',
      exitCode: EXIT_CODES.providerConfig,
      spec: finalSpec,
      postImplementationReview: postReview || message,
      decision,
    };
  }
}
