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
  CriticNarrativeSections,
  CriticParseResult,
  StructuralCheck,
  dedupeBlockers,
  getBlockingBlockers,
  parseCriticMarkdownTable,
  parseCriticNarrative,
  structuralRubric,
  trimApproxTokens,
} from './rubric.js';

export type DebateMode = 'free' | 'free+low' | 'debate';

export type PipelineStatus =
  | 'REVIEWED'
  | 'UNREVIEWED'
  | 'DEGRADED_LOW'
  | 'FAILED_BLOCKER'
  | 'ESCALATION_REQUIRED'
  | 'FAILED_EXPENSIVE'
  | 'NO_HIGH_TIER'
  | 'ERROR';

export type PipelineEventType =
  | 'step_start'
  | 'step_done'
  | 'step_error'
  | 'round_done'
  | 'run_done';

export interface PipelineEvent {
  type: PipelineEventType;
  ts: string;
  round?: number;
  step: string;
  provider?: string;
  model?: string;
  prompt?: string;
  output?: string;
  error?: string;
  timingMs?: number;
  meta?: Record<string, unknown>;
}

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
  freeRoundBudgetMs: 3 * 60_000,
  freeLowRoundBudgetMs: 5 * 60_000,
  debateRoundBudgetMs: 10 * 60_000,
} as const;

export interface PipelineInput {
  goal: string;
  mode: DebateMode;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  repeat: number;
  enableGemini: boolean;
  enableKimi: boolean;
  freeTierOnly: boolean;
  onEvent?: (event: PipelineEvent) => void;
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
  narrative: CriticNarrativeSections;
  raw: string;
  error?: string;
}

export interface PipelineDecision {
  status: PipelineStatus;
  mode: DebateMode;
  goal: string;
  repeatRequested: number;
  repeatRoundsUsed: number;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  tiersUsed: number[];
  degraded: boolean;
  degradedLow: boolean;
  unresolvedBlocking: Blocker[];
  structural: StructuralCheck;
  critics: CriticRun[];
  notes: string[];
  callCounts: Record<string, number>;
  providerPolicy: {
    geminiEnabled: boolean;
    kimiEnabled: boolean;
    freeTierOnly: boolean;
    openRouterAvailable: boolean;
    freeDrafterModel: string;
    freeCriticModel: string;
  };
  timingMs: {
    total: number;
    free: number;
    low: number;
    high: number;
  };
  convergenceReason: 'CLEAN' | 'MAX_REPEAT' | 'BLOCKING' | 'UNREVIEWED' | 'NO_HIGH_TIER' | 'ERROR';
  freePromptUsage: {
    used: number;
    dailyLimit: number;
    nearLimit: boolean;
  };
  costEstimateUsd: number;
}

export interface PipelineResult {
  status: PipelineStatus;
  exitCode: number;
  spec: string;
  postImplementationReview: string;
  decision: PipelineDecision;
  trace: PipelineEvent[];
}

interface ProviderPolicy {
  allowGemini: boolean;
  allowKimi: boolean;
  allowOpenRouter: boolean;
  freeTierOnly: boolean;
}

interface StepContext {
  input: PipelineInput;
  decision: PipelineDecision;
  models: ReturnType<typeof getDefaultModels>;
  policy: ProviderPolicy;
  trace: PipelineEvent[];
}

interface RoundState {
  spec: string;
  blockers: Blocker[];
  hasMinorFindings: boolean;
  clean: boolean;
  unreviewed: boolean;
  degradedLow: boolean;
  highTierMissing: boolean;
  highTierExecuted: boolean;
  structural: StructuralCheck;
  postSections: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function emitEvent(ctx: StepContext, event: PipelineEvent): void {
  ctx.trace.push(event);
  if (ctx.input.onEvent) ctx.input.onEvent(event);
}

function pushNote(ctx: StepContext, note: string): void {
  ctx.decision.notes.push(note);
}

function registerCall(ctx: StepContext, key: string): void {
  ctx.decision.callCounts[key] = (ctx.decision.callCounts[key] || 0) + 1;
}

function markTier(ctx: StepContext, tier: 1 | 2 | 3): void {
  if (!ctx.decision.tiersUsed.includes(tier)) ctx.decision.tiersUsed.push(tier);
}

function computeExitCode(status: PipelineStatus): number {
  switch (status) {
    case 'FAILED_BLOCKER':
      return EXIT_CODES.failedBlocker;
    case 'ESCALATION_REQUIRED':
    case 'NO_HIGH_TIER':
      return EXIT_CODES.escalationRequired;
    case 'FAILED_EXPENSIVE':
      return EXIT_CODES.failedExpensive;
    case 'ERROR':
      return EXIT_CODES.providerConfig;
    default:
      return EXIT_CODES.success;
  }
}

function trimOutput(text: string): string {
  return trimApproxTokens(text, LIMITS.draftTokens);
}

function summarizeCritique(raw: string): string {
  return trimApproxTokens(raw, LIMITS.critiqueSummaryTokens);
}

function hasMinorFindings(runs: CriticRun[]): boolean {
  return runs.some((run) =>
    run.parse.blockers.some((blocker) => blocker.severity === 'MINOR'),
  );
}

function collectBlocking(runs: CriticRun[]): Blocker[] {
  const all = runs
    .filter((run) => run.available && run.structured)
    .flatMap((run) => getBlockingBlockers(run.parse.blockers));
  return dedupeBlockers(all);
}

function buildDraftPrompt(goal: string, priorSpec?: string): string {
  if (priorSpec?.trim()) {
    return [
      'Revise this existing implementation spec for clarity, feasibility, and correctness.',
      `Goal: ${goal}`,
      '',
      'Requirements:',
      '- Preserve actionable content and tighten ambiguous steps.',
      '- Optimize for MVP and Pareto outcomes first.',
      '- Keep style changes minimal unless they remove confusion.',
      '',
      'Return markdown with required sections:',
      '## Summary',
      '## Architecture',
      '## Implementation Changes',
      '## Test Plan',
      '## Risks',
      '',
      'Existing spec:',
      priorSpec,
    ].join('\n');
  }

  return [
    'You are writing an implementation specification for software engineers.',
    `Goal: ${goal}`,
    '',
    'Requirements:',
    '- Optimize for MVP and Pareto outcomes first.',
    '- Focus on concrete, testable implementation steps.',
    '- Include edge cases and failure modes.',
    '',
    'Return markdown with these required sections:',
    '## Summary',
    '## Architecture',
    '## Implementation Changes',
    '## Test Plan',
    '## Risks',
  ].join('\n');
}

function buildCriticPrompt(goal: string, spec: string, focus: string): string {
  return [
    'Review this implementation spec.',
    '',
    'Output format (strict):',
    '| ID | Severity | Description | Fix |',
    '|:---|:---|:---|:---|',
    '| B1 | BLOCKING | ... | ... |',
    'ASSESSMENT: CLEAN|MINOR|BLOCKING',
    '',
    'Then include these sections exactly (short bullets):',
    'AGREEMENTS:',
    'DISAGREEMENTS:',
    'HOLES:',
    'STYLE_ONLY:',
    'MVP:',
    'PARETO:',
    '',
    `Focus: ${focus}`,
    `Goal: ${goal}`,
    '',
    'Rules:',
    '- BLOCKING only for critical correctness/security/reliability failures.',
    '- MINOR for non-blocking improvements.',
    '- Gate logic uses only blocker table + ASSESSMENT.',
    '',
    'Spec to review:',
    spec,
  ].join('\n');
}

function buildRewritePrompt(
  goal: string,
  currentSpec: string,
  feedback: string,
  tierLabel: 'free' | 'low' | 'high',
): string {
  return [
    `Revise this implementation spec after ${tierLabel.toUpperCase()} critique.`,
    `Goal: ${goal}`,
    '',
    'Priorities:',
    '- Resolve blockers and holes first.',
    '- Preserve useful MVP and Pareto improvements.',
    '- Do not churn style-only items unless they remove ambiguity.',
    '',
    'Current spec:',
    currentSpec,
    '',
    'Critique feedback:',
    feedback,
    '',
    'Return markdown with required sections:',
    '## Summary',
    '## Architecture',
    '## Implementation Changes',
    '## Test Plan',
    '## Risks',
  ].join('\n');
}

function toReviewMarkdown(run: CriticRun): string {
  if (!run.available) {
    return `### ${run.critic}\n- Status: unavailable\n- Error: ${run.error || 'n/a'}\n`;
  }
  const parts: string[] = [];
  parts.push(`### ${run.critic}`);
  parts.push(run.raw.trim() || '(empty output)');
  parts.push('');
  parts.push('Parsed narrative:');
  parts.push(`- Agreements: ${run.narrative.agreements.join(' | ') || 'none'}`);
  parts.push(
    `- Disagreements: ${run.narrative.disagreements.join(' | ') || 'none'}`,
  );
  parts.push(`- Holes: ${run.narrative.holes.join(' | ') || 'none'}`);
  parts.push(`- Style-only: ${run.narrative.styleOnly.join(' | ') || 'none'}`);
  parts.push(`- MVP: ${run.narrative.mvp.join(' | ') || 'none'}`);
  parts.push(`- Pareto: ${run.narrative.pareto.join(' | ') || 'none'}`);
  return parts.join('\n');
}

function resolveProviderPolicy(input: PipelineInput): ProviderPolicy {
  const allowOpenRouter = canUseOpenRouter();
  if (input.freeTierOnly) {
    return {
      allowGemini: false,
      allowKimi: false,
      allowOpenRouter,
      freeTierOnly: true,
    };
  }
  return {
    allowGemini: input.enableGemini && canUseGemini(),
    allowKimi: input.enableKimi && canUseKimi(),
    allowOpenRouter,
    freeTierOnly: false,
  };
}

async function runStep<T extends { text?: string; raw?: string }>(
  ctx: StepContext,
  config: {
    round: number;
    step: string;
    provider: string;
    model: string;
    prompt: string;
    call: () => Promise<T>;
  },
): Promise<T> {
  emitEvent(ctx, {
    type: 'step_start',
    ts: nowIso(),
    round: config.round,
    step: config.step,
    provider: config.provider,
    model: config.model,
    prompt: config.prompt,
  });
  const started = Date.now();
  try {
    const result = await config.call();
    emitEvent(ctx, {
      type: 'step_done',
      ts: nowIso(),
      round: config.round,
      step: config.step,
      provider: config.provider,
      model: config.model,
      prompt: config.prompt,
      output: result.text || result.raw || '',
      timingMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitEvent(ctx, {
      type: 'step_error',
      ts: nowIso(),
      round: config.round,
      step: config.step,
      provider: config.provider,
      model: config.model,
      prompt: config.prompt,
      error: message,
      timingMs: Date.now() - started,
    });
    throw err;
  }
}

async function runCritic(
  ctx: StepContext,
  config: {
    round: number;
    step: string;
    critic: string;
    provider: string;
    model: string;
    tier: 1 | 2 | 3;
    prompt: string;
    call: () => Promise<{ text: string }>;
  },
): Promise<CriticRun> {
  try {
    registerCall(ctx, `${config.provider}:${config.model}`);
    const response = await runStep(ctx, {
      round: config.round,
      step: config.step,
      provider: config.provider,
      model: config.model,
      prompt: config.prompt,
      call: config.call,
    });
    const raw = response.text.trim();
    const parse = parseCriticMarkdownTable(raw);
    const narrative = parseCriticNarrative(raw);
    const run: CriticRun = {
      critic: config.critic,
      provider: config.provider,
      model: config.model,
      tier: config.tier,
      available: true,
      structured: parse.structured,
      timedOut: false,
      parse,
      narrative,
      raw,
      error: parse.error,
    };
    if (!parse.structured) {
      ctx.decision.degraded = true;
      pushNote(
        ctx,
        `${config.critic} returned unstructured output; excluded from blocker merge.`,
      );
    }
    ctx.decision.critics.push(run);
    return run;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const run: CriticRun = {
      critic: config.critic,
      provider: config.provider,
      model: config.model,
      tier: config.tier,
      available: false,
      structured: false,
      timedOut: /timed out/i.test(message),
      parse: {
        assessment: 'UNSTRUCTURED',
        blockers: [],
        structured: false,
        error: message,
      },
      narrative: {
        agreements: [],
        disagreements: [],
        holes: [],
        styleOnly: [],
        mvp: [],
        pareto: [],
      },
      raw: '',
      error: message,
    };
    ctx.decision.degraded = true;
    pushNote(ctx, `${config.critic} unavailable: ${message}`);
    ctx.decision.critics.push(run);
    return run;
  }
}

async function draftWithFreePipeline(
  ctx: StepContext,
  round: number,
  prompt: string,
): Promise<{ text: string; provider: string; model: string }> {
  const attempts: Array<{
    provider: string;
    model: string;
    call: () => Promise<{ text: string; provider: string; model: string }>;
  }> = [];

  if (ctx.policy.allowOpenRouter) {
    attempts.push({
      provider: 'openrouter',
      model: ctx.models.freeDrafter,
      call: async () => {
        registerCall(ctx, `openrouter:${ctx.models.freeDrafter}`);
        return await runStep(ctx, {
          round,
          step: 'free_draft_qwen',
          provider: 'openrouter',
          model: ctx.models.freeDrafter,
          prompt,
          call: async () =>
            await callOpenRouter([{ role: 'user', content: prompt }], {
              model: ctx.models.freeDrafter,
              maxOutputTokens: LIMITS.draftTokens,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature: 0.2,
            }),
        });
      },
    });
  }

  if (ctx.policy.allowGemini) {
    attempts.push({
      provider: 'gemini',
      model: ctx.models.geminiFreeCritic,
      call: async () => {
        registerCall(ctx, `gemini:${ctx.models.geminiFreeCritic}`);
        return await runStep(ctx, {
          round,
          step: 'free_draft_gemini_fallback',
          provider: 'gemini',
          model: ctx.models.geminiFreeCritic,
          prompt,
          call: async () =>
            await callGemini(prompt, {
              modelOverride: ctx.models.geminiFreeCritic,
              maxOutputTokens: LIMITS.draftTokens,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature: 0.2,
            }),
        });
      },
    });
  }

  if (attempts.length === 0) {
    throw new Error(
      'No free drafter available. Configure OpenRouter free route or Gemini.',
    );
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await attempt.call();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.provider}/${attempt.model}: ${message}`);
    }
  }
  throw new Error(`All free drafter attempts failed. ${errors.join(' | ')}`);
}

async function runFreeRound(
  ctx: StepContext,
  round: number,
  goal: string,
  seedSpec?: string,
): Promise<RoundState> {
  markTier(ctx, 1);
  const roundStart = Date.now();
  const draftPrompt = buildDraftPrompt(goal, seedSpec);
  const draft = await draftWithFreePipeline(ctx, round, draftPrompt);
  let spec = trimOutput(draft.text);
  pushNote(ctx, `Round ${round}: free draft by ${draft.provider}/${draft.model}`);

  const freeCriticPrompt = buildCriticPrompt(
    goal,
    spec,
    'Architecture and implementation feasibility blockers only.',
  );

  const criticRuns: CriticRun[] = [];
  if (ctx.policy.allowGemini) {
    const geminiCritic = await runCritic(ctx, {
      round,
      step: 'free_critic_gemini',
      critic: 'FreeCriticGemini',
      provider: 'gemini',
      model: ctx.models.geminiFreeCritic,
      tier: 1,
      prompt: freeCriticPrompt,
      call: async () =>
        await callGemini(freeCriticPrompt, {
          modelOverride: ctx.models.geminiFreeCritic,
          maxOutputTokens: 1000,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.1,
        }),
    });
    criticRuns.push(geminiCritic);
  } else if (ctx.policy.allowOpenRouter) {
    const fallbackCritic = await runCritic(ctx, {
      round,
      step: 'free_critic_openrouter_fallback',
      critic: 'FreeCriticFallback',
      provider: 'openrouter',
      model: ctx.models.freeCritic,
      tier: 1,
      prompt: freeCriticPrompt,
      call: async () =>
        await callOpenRouter([{ role: 'user', content: freeCriticPrompt }], {
          model: ctx.models.freeCritic,
          maxOutputTokens: 1000,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.1,
        }),
    });
    criticRuns.push(fallbackCritic);
    ctx.decision.degraded = true;
    pushNote(ctx, 'Gemini critic unavailable; used OpenRouter free critic fallback.');
  }

  let unreviewed = false;
  if (criticRuns.length === 0 || criticRuns.every((run) => !run.available)) {
    unreviewed = true;
    ctx.decision.degraded = true;
    pushNote(ctx, 'Free round critics unavailable. Round marked UNREVIEWED.');
  } else {
    const critiqueSummary = criticRuns
      .filter((run) => run.available)
      .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
      .join('\n\n');
    const rewritePrompt = buildRewritePrompt(goal, spec, critiqueSummary, 'free');
    const rewrite = await draftWithFreePipeline(ctx, round, rewritePrompt);
    spec = trimOutput(rewrite.text);
  }

  const blocking = collectBlocking(criticRuns);
  const hasMinor = hasMinorFindings(criticRuns);
  const structural = structuralRubric(spec);
  const clean =
    !unreviewed &&
    criticRuns.length > 0 &&
    criticRuns
      .filter((run) => run.available && run.structured)
      .every((run) => run.parse.assessment === 'CLEAN') &&
    blocking.length === 0 &&
    !hasMinor &&
    structural.passed;

  if (Date.now() - roundStart > LIMITS.freeRoundBudgetMs) {
    pushNote(ctx, `Round ${round}: FREE stage exceeded target budget.`);
  }

  return {
    spec,
    blockers: blocking,
    hasMinorFindings: hasMinor,
    clean,
    unreviewed,
    degradedLow: false,
    highTierMissing: false,
    highTierExecuted: false,
    structural,
    postSections: criticRuns.map((run) => toReviewMarkdown(run)),
  };
}

async function runFreeLowRound(
  ctx: StepContext,
  round: number,
  goal: string,
  seedSpec?: string,
): Promise<RoundState> {
  const roundStart = Date.now();
  const free = await runFreeRound(ctx, round, goal, seedSpec);
  let spec = free.spec;
  const allSections = [...free.postSections];
  const lowRuns: CriticRun[] = [];
  let degradedLow = false;

  markTier(ctx, 2);
  const lowPrompt = buildCriticPrompt(
    goal,
    spec,
    'Security, edge cases, and reliability blockers.',
  );

  const runLowKimi = async (step: string, critic: string): Promise<CriticRun> =>
    await runCritic(ctx, {
      round,
      step,
      critic,
      provider: 'kimi',
      model: ctx.models.kimiLowCritic,
      tier: 2,
      prompt: lowPrompt,
      call: async () =>
        await callKimi(lowPrompt, {
          modelOverride: ctx.models.kimiLowCritic,
          maxOutputTokens: 1000,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.1,
        }),
    });

  const runLowGemini = async (
    step: string,
    critic: string,
  ): Promise<CriticRun> =>
    await runCritic(ctx, {
      round,
      step,
      critic,
      provider: 'gemini',
      model: ctx.models.geminiLowCritic,
      tier: 2,
      prompt: lowPrompt,
      call: async () =>
        await callGemini(lowPrompt, {
          modelOverride: ctx.models.geminiLowCritic,
          maxOutputTokens: 1000,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature: 0.1,
        }),
    });

  let lowCriticPrimary: CriticRun | undefined;
  if (ctx.policy.allowKimi) {
    lowCriticPrimary = await runLowKimi('low_critic_kimi_primary', 'LowCriticKimi');
  } else if (ctx.policy.allowGemini) {
    lowCriticPrimary = await runLowGemini(
      'low_critic_gemini_primary_fallback',
      'LowCriticGeminiPrimary',
    );
  }
  if (lowCriticPrimary) lowRuns.push(lowCriticPrimary);

  let lowCriticSecond: CriticRun | undefined;
  if (lowCriticPrimary?.provider === 'kimi' && ctx.policy.allowGemini) {
    lowCriticSecond = await runLowGemini(
      'low_critic_gemini_secondary',
      'LowCriticGeminiSecondary',
    );
  } else if (lowCriticPrimary?.provider === 'gemini' && ctx.policy.allowKimi) {
    lowCriticSecond = await runLowKimi(
      'low_critic_kimi_secondary',
      'LowCriticKimiSecondary',
    );
  }
  if (lowCriticSecond) lowRuns.push(lowCriticSecond);

  if (lowRuns.length === 0 || lowRuns.every((run) => !run.available)) {
    degradedLow = true;
    ctx.decision.degraded = true;
    ctx.decision.degradedLow = true;
    pushNote(ctx, 'Low-tier critics unavailable. Returning FREE result as DEGRADED_LOW.');
  } else {
    if (lowRuns.length === 1) {
      degradedLow = true;
      ctx.decision.degraded = true;
      ctx.decision.degradedLow = true;
      pushNote(ctx, 'Low-tier executed with a single critic (degraded).');
    }
    const lowSummary = lowRuns
      .filter((run) => run.available)
      .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
      .join('\n\n');

    const rewritePrompt = buildRewritePrompt(goal, spec, lowSummary, 'low');
    const reviserProvider =
      lowRuns.find((run) => run.available && run.provider === 'kimi')?.provider ||
      lowRuns.find((run) => run.available && run.provider === 'gemini')?.provider;

    if (reviserProvider === 'kimi') {
      registerCall(ctx, `kimi:${ctx.models.kimiLowCritic}`);
      const revised = await runStep(ctx, {
        round,
        step: 'low_rewrite_kimi',
        provider: 'kimi',
        model: ctx.models.kimiLowCritic,
        prompt: rewritePrompt,
        call: async () =>
          await callKimi(rewritePrompt, {
            modelOverride: ctx.models.kimiLowCritic,
            maxOutputTokens: LIMITS.draftTokens,
            timeoutMs: LIMITS.perCallTimeoutMs,
            temperature: 0.2,
          }),
      });
      spec = trimOutput(revised.text);
    } else if (reviserProvider === 'gemini') {
      registerCall(ctx, `gemini:${ctx.models.geminiLowCritic}`);
      const revised = await runStep(ctx, {
        round,
        step: 'low_rewrite_gemini',
        provider: 'gemini',
        model: ctx.models.geminiLowCritic,
        prompt: rewritePrompt,
        call: async () =>
          await callGemini(rewritePrompt, {
            modelOverride: ctx.models.geminiLowCritic,
            maxOutputTokens: LIMITS.draftTokens,
            timeoutMs: LIMITS.perCallTimeoutMs,
            temperature: 0.2,
          }),
      });
      spec = trimOutput(revised.text);
    }
  }

  const combinedBlocking = dedupeBlockers([...free.blockers, ...collectBlocking(lowRuns)]);
  const hasMinor = free.hasMinorFindings || hasMinorFindings(lowRuns);
  const structural = structuralRubric(spec);
  const clean =
    free.clean &&
    !degradedLow &&
    lowRuns.length > 0 &&
    lowRuns
      .filter((run) => run.available && run.structured)
      .every((run) => run.parse.assessment === 'CLEAN') &&
    combinedBlocking.length === 0 &&
    !hasMinor &&
    structural.passed;

  allSections.push(...lowRuns.map((run) => toReviewMarkdown(run)));
  if (Date.now() - roundStart > LIMITS.freeLowRoundBudgetMs) {
    pushNote(ctx, `Round ${round}: FREE+LOW stage exceeded target budget.`);
  }

  return {
    spec,
    blockers: combinedBlocking,
    hasMinorFindings: hasMinor,
    clean,
    unreviewed: free.unreviewed,
    degradedLow,
    highTierMissing: false,
    highTierExecuted: false,
    structural,
    postSections: allSections,
  };
}

async function runDebateRound(
  ctx: StepContext,
  round: number,
  goal: string,
  seedSpec?: string,
): Promise<RoundState> {
  const roundStart = Date.now();
  const low = await runFreeLowRound(ctx, round, goal, seedSpec);
  let spec = low.spec;
  const sections = [...low.postSections];
  let highTierMissing = false;
  let highTierExecuted = false;

  const highEnabled =
    !ctx.policy.freeTierOnly &&
    ctx.input.allowTier3 &&
    ctx.input.tierLimit >= 3 &&
    ctx.policy.allowOpenRouter &&
    hasEnv('ANTHROPIC_API_KEY');

  if (!highEnabled) {
    highTierMissing = true;
    pushNote(
      ctx,
      'Debate mode requested but high tier unavailable (allow-tier-3/tier-limit/key/provider missing).',
    );
    if (Date.now() - roundStart > LIMITS.debateRoundBudgetMs) {
      pushNote(ctx, `Round ${round}: DEBATE stage exceeded target budget.`);
    }
    return {
      ...low,
      highTierMissing,
      highTierExecuted,
    };
  }

  markTier(ctx, 3);
  highTierExecuted = true;

  const codexPrompt = buildCriticPrompt(
    goal,
    spec,
    'Implementation feasibility blockers and test coverage gaps only.',
  );
  const codexCritic = await runCritic(ctx, {
    round,
    step: 'high_critic_codex',
    critic: 'CodexCritic',
    provider: 'openrouter',
    model: ctx.models.codexCritic,
    tier: 3,
    prompt: codexPrompt,
    call: async () =>
      await callOpenRouter([{ role: 'user', content: codexPrompt }], {
        model: ctx.models.codexCritic,
        maxOutputTokens: 1200,
        timeoutMs: LIMITS.perCallTimeoutMs,
        temperature: 0.1,
      }),
  });

  const claudeCriticPrompt = buildCriticPrompt(
    goal,
    spec,
    'Architecture and long-term maintainability blockers.',
  );
  const claudeCritic = await runCritic(ctx, {
    round,
    step: 'high_critic_claude',
    critic: 'ClaudeCritic',
    provider: 'anthropic',
    model: ctx.models.opus,
    tier: 3,
    prompt: claudeCriticPrompt,
    call: async () =>
      await callAnthropic(claudeCriticPrompt, {
        model: ctx.models.opus,
        maxOutputTokens: 1200,
        timeoutMs: LIMITS.perCallTimeoutMs,
        temperature: 0.1,
      }),
  });

  const highSummary = [codexCritic, claudeCritic]
    .filter((run) => run.available)
    .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
    .join('\n\n');

  registerCall(ctx, `anthropic:${ctx.models.sonnet}`);
  const rewritePrompt = buildRewritePrompt(goal, spec, highSummary, 'high');
  const rewritten = await runStep(ctx, {
    round,
    step: 'high_rewrite_claude',
    provider: 'anthropic',
    model: ctx.models.sonnet,
    prompt: rewritePrompt,
    call: async () =>
      await callAnthropic(rewritePrompt, {
        model: ctx.models.sonnet,
        maxOutputTokens: LIMITS.draftTokens,
        timeoutMs: LIMITS.perCallTimeoutMs,
        temperature: 0.2,
      }),
  });
  spec = trimOutput(rewritten.text);

  const highBlocking = collectBlocking([codexCritic, claudeCritic]);
  const blockers = dedupeBlockers([...low.blockers, ...highBlocking]);
  const hasMinor = low.hasMinorFindings || hasMinorFindings([codexCritic, claudeCritic]);
  const structural = structuralRubric(spec);
  const clean =
    low.clean &&
    [codexCritic, claudeCritic]
      .filter((run) => run.available && run.structured)
      .every((run) => run.parse.assessment === 'CLEAN') &&
    blockers.length === 0 &&
    !hasMinor &&
    structural.passed;

  sections.push(toReviewMarkdown(codexCritic), toReviewMarkdown(claudeCritic));
  if (Date.now() - roundStart > LIMITS.debateRoundBudgetMs) {
    pushNote(ctx, `Round ${round}: DEBATE stage exceeded target budget.`);
  }

  return {
    spec,
    blockers,
    hasMinorFindings: hasMinor,
    clean,
    unreviewed: low.unreviewed,
    degradedLow: low.degradedLow,
    highTierMissing,
    highTierExecuted,
    structural,
    postSections: sections,
  };
}

function estimateCostUsd(callCounts: Record<string, number>): number {
  let total = 0;
  for (const [key, count] of Object.entries(callCounts)) {
    const lower = key.toLowerCase();
    if (lower.includes(':free')) continue;
    if (lower.startsWith('openrouter:openai/codex')) total += count * 0.01;
    else if (lower.startsWith('anthropic:') && lower.includes('opus')) total += count * 0.3;
    else if (lower.startsWith('anthropic:')) total += count * 0.1;
    else if (lower.startsWith('kimi:')) total += count * 0.003;
    else if (lower.startsWith('gemini:') && lower.includes('2.5-pro')) total += count * 0.005;
    else if (lower.startsWith('gemini:')) total += count * 0.001;
    else if (lower.startsWith('openrouter:')) total += count * 0.002;
  }
  return Number(total.toFixed(4));
}

function countFreeCalls(callCounts: Record<string, number>): number {
  return Object.entries(callCounts)
    .filter(([key]) => key.toLowerCase().includes(':free'))
    .reduce((sum, [, count]) => sum + count, 0);
}

function initDecision(input: PipelineInput): PipelineDecision {
  return {
    status: 'ERROR',
    mode: input.mode,
    goal: input.goal,
    repeatRequested: input.repeat,
    repeatRoundsUsed: 0,
    tierLimit: input.tierLimit,
    allowTier3: input.allowTier3,
    tiersUsed: [],
    degraded: false,
    degradedLow: false,
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
    providerPolicy: {
      geminiEnabled: false,
      kimiEnabled: false,
      freeTierOnly: input.freeTierOnly,
      openRouterAvailable: false,
      freeDrafterModel: '',
      freeCriticModel: '',
    },
    timingMs: {
      total: 0,
      free: 0,
      low: 0,
      high: 0,
    },
    convergenceReason: 'ERROR',
    freePromptUsage: {
      used: 0,
      dailyLimit: Number.parseInt(process.env.SPEC_FREE_PROMPT_DAILY_LIMIT || '50', 10) || 50,
      nearLimit: false,
    },
    costEstimateUsd: 0,
  };
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const started = Date.now();
  const decision = initDecision(input);
  const models = getDefaultModels();
  const policy = resolveProviderPolicy(input);
  const trace: PipelineEvent[] = [];

  const ctx: StepContext = {
    input,
    decision,
    models,
    policy,
    trace,
  };

  decision.providerPolicy = {
    geminiEnabled: policy.allowGemini,
    kimiEnabled: policy.allowKimi,
    freeTierOnly: policy.freeTierOnly,
    openRouterAvailable: policy.allowOpenRouter,
    freeDrafterModel: models.freeDrafter,
    freeCriticModel: models.freeCritic,
  };

  let finalSpec = '';
  let postReview = '';
  let lastRound: RoundState | undefined;

  try {
    if (!policy.allowOpenRouter && !policy.allowGemini) {
      throw new Error(
        'No drafter available. Configure OpenRouter free route or Gemini.',
      );
    }

    const repeat = Math.max(1, Math.min(10, input.repeat));
    let seedSpec: string | undefined;

    for (let round = 1; round <= repeat; round += 1) {
      const stageStart = Date.now();
      let roundState: RoundState;
      if (input.mode === 'free') {
        roundState = await runFreeRound(ctx, round, input.goal, seedSpec);
        decision.timingMs.free += Date.now() - stageStart;
      } else if (input.mode === 'free+low') {
        roundState = await runFreeLowRound(ctx, round, input.goal, seedSpec);
        decision.timingMs.low += Date.now() - stageStart;
      } else {
        roundState = await runDebateRound(ctx, round, input.goal, seedSpec);
        decision.timingMs.high += Date.now() - stageStart;
      }

      finalSpec = roundState.spec;
      decision.structural = roundState.structural;
      decision.unresolvedBlocking = roundState.blockers;
      decision.repeatRoundsUsed = round;
      decision.degradedLow = decision.degradedLow || roundState.degradedLow;
      decision.degraded = decision.degraded || roundState.unreviewed || roundState.degradedLow;
      seedSpec = finalSpec;
      lastRound = roundState;

      emitEvent(ctx, {
        type: 'round_done',
        ts: nowIso(),
        round,
        step: 'round_done',
        meta: {
          mode: input.mode,
          clean: roundState.clean,
          blockers: roundState.blockers.length,
          minors: roundState.hasMinorFindings,
          structuralPassed: roundState.structural.passed,
          highTierMissing: roundState.highTierMissing,
        },
      });

      if (roundState.clean) {
        decision.convergenceReason = 'CLEAN';
        break;
      }
      if (round === repeat) {
        decision.convergenceReason =
          roundState.unreviewed
            ? 'UNREVIEWED'
            : roundState.highTierMissing
              ? 'NO_HIGH_TIER'
              : roundState.blockers.length > 0
                ? 'BLOCKING'
                : 'MAX_REPEAT';
      }
    }

    if (!lastRound) throw new Error('Pipeline ended without producing a round.');

    if (lastRound.unreviewed) {
      decision.status = 'UNREVIEWED';
    } else if (input.mode === 'debate' && lastRound.highTierMissing) {
      decision.status = 'NO_HIGH_TIER';
    } else if (!decision.structural.passed) {
      decision.status =
        input.mode === 'debate' && lastRound.highTierExecuted
          ? 'FAILED_EXPENSIVE'
          : 'FAILED_BLOCKER';
      pushNote(
        ctx,
        `Structural rubric failed: ${decision.structural.missing.join(', ')}`,
      );
    } else if (decision.unresolvedBlocking.length > 0) {
      if (input.mode === 'debate' && !input.allowTier3) {
        decision.status = 'ESCALATION_REQUIRED';
      } else if (input.mode === 'debate' && lastRound.highTierExecuted) {
        decision.status = 'FAILED_EXPENSIVE';
      } else {
        decision.status = 'FAILED_BLOCKER';
      }
    } else if (decision.degradedLow) {
      decision.status = 'DEGRADED_LOW';
    } else {
      decision.status = 'REVIEWED';
    }

    postReview = lastRound.postSections.join('\n\n').trim();
    if (!postReview) {
      postReview =
        decision.status === 'NO_HIGH_TIER'
          ? 'Debate high tier was not available; returned lower-tier result.'
          : 'No post-review details available.';
    }

    decision.costEstimateUsd = estimateCostUsd(decision.callCounts);
    decision.freePromptUsage.used = countFreeCalls(decision.callCounts);
    decision.freePromptUsage.nearLimit =
      decision.freePromptUsage.used >=
      Math.floor(decision.freePromptUsage.dailyLimit * 0.8);
    decision.timingMs.total = Date.now() - started;

    emitEvent(ctx, {
      type: 'run_done',
      ts: nowIso(),
      step: 'run_done',
      meta: {
        status: decision.status,
        roundsUsed: decision.repeatRoundsUsed,
        costEstimateUsd: decision.costEstimateUsd,
        freePromptUsage: decision.freePromptUsage,
      },
    });

    return {
      status: decision.status,
      exitCode: computeExitCode(decision.status),
      spec: finalSpec,
      postImplementationReview: postReview,
      decision,
      trace,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    decision.status = 'ERROR';
    decision.convergenceReason = 'ERROR';
    decision.notes.push(`Pipeline error: ${message}`);
    decision.costEstimateUsd = estimateCostUsd(decision.callCounts);
    decision.freePromptUsage.used = countFreeCalls(decision.callCounts);
    decision.freePromptUsage.nearLimit =
      decision.freePromptUsage.used >=
      Math.floor(decision.freePromptUsage.dailyLimit * 0.8);
    decision.timingMs.total = Date.now() - started;
    emitEvent(ctx, {
      type: 'run_done',
      ts: nowIso(),
      step: 'run_done',
      error: message,
      meta: {
        status: decision.status,
      },
    });
    return {
      status: 'ERROR',
      exitCode: EXIT_CODES.providerConfig,
      spec: finalSpec,
      postImplementationReview: postReview || message,
      decision,
      trace,
    };
  }
}
