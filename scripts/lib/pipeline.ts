import process from 'node:process';

import {
  CliCapabilitiesSnapshot,
  ProviderAuthError,
  ProviderEmptyError,
  ProviderError,
  ProviderErrorKind,
  ProviderNetworkError,
  ProviderParseError,
  ProviderResult,
  ProviderTimeoutError,
  ProviderTokenUsage,
  canUseGemini,
  canUseKimi,
  canUseOpenRouter,
  callAnthropic,
  callGemini,
  callKimi,
  callOpenRouter,
  getCliCapabilitiesSnapshot,
  getDefaultModels,
  hasEnv,
} from './providers.js';
import {
  Blocker,
  CriticNarrativeSections,
  CriticParseResult,
  SanitizeResult,
  StructuralCheck,
  dedupeBlockers,
  getBlockingBlockers,
  parseCriticMarkdownTable,
  parseCriticNarrative,
  sanitizeOutput,
  stripReviewMetadataSections,
  structuralRubric,
  trimApproxTokens,
} from './rubric.js';

export type DebateMode = 'free' | 'free+low' | 'debate';

export type PipelineStatus =
  | 'REVIEWED'
  | 'REVIEWED_WITH_MINORS'
  | 'UNREVIEWED'
  | 'DEGRADED_LOW'
  | 'STOPPED'
  | 'QUOTA_EXHAUSTED'
  | 'FAILED_BLOCKER'
  | 'FAILED_RUBRIC'
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
  quotaExhausted: 14,
  stopped: 130,
} as const;

const LIMITS = {
  draftTokens: 4000,
  critiqueSpecTokens: 3200,
  critiqueSummaryTokens: 800,
  decisionMemoryTokens: 500,
  perCallTimeoutMs: 90_000,
  freeRoundBudgetMs: 3 * 60_000,
  freeLowRoundBudgetMs: 5 * 60_000,
  debateRoundBudgetMs: 10 * 60_000,
  repairAttempts: 2,
  compactAttempts: 1,
  goalMaxChars: 3000,
  goalSummaryMaxWords: 500,
} as const;

export interface PipelineResumeCheckpoint {
  goal: string;
  spec: string;
  blockers: Blocker[];
  structural: StructuralCheck;
  postSections: string[];
}

export interface PipelineInput {
  goal: string;
  userNotes?: string;
  mode: DebateMode;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  repeat: number;
  enableGemini: boolean;
  enableKimi: boolean;
  freeTierOnly: boolean;
  abortSignal?: AbortSignal;
  resumeCheckpoint?: PipelineResumeCheckpoint;
  keepHistory?: boolean;
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
  errorKind?: ProviderErrorKind;
  error?: string;
}

export interface TokenUsageSummary {
  total: ProviderTokenUsage;
  byProviderModel: Record<string, ProviderTokenUsage>;
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
  convergenceReason:
    | 'CLEAN'
    | 'MAX_REPEAT'
    | 'BLOCKING'
    | 'STOPPED'
    | 'QUOTA_EXHAUSTED'
    | 'UNREVIEWED'
    | 'NO_HIGH_TIER'
    | 'FAILED_RUBRIC'
    | 'ERROR';
  goalNormalization: {
    summarized: boolean;
    rawChars: number;
    normalizedChars: number;
    summarizerProviderModel?: string;
    truncatedAfterSummary: boolean;
  };
  containsReviewMetadata: boolean;
  reviewMetadataMarkers: string[];
  freePromptUsage: {
    used: number;
    dailyLimit: number;
    nearLimit: boolean;
  };
  costEstimateUsd: number;
  resumeFrom: 'high' | null;
  checkpointPath: string | null;
  sanitizeWarnings: string[];
  cliCapabilities: CliCapabilitiesSnapshot;
  tokenUsage: TokenUsageSummary;
}

export interface SpecHistoryEntry {
  round: number;
  mode: DebateMode;
  spec: string;
  blockers: number;
  structuralPassed: boolean;
}

export interface PipelineResult {
  status: PipelineStatus;
  exitCode: number;
  spec: string;
  postImplementationReview: string;
  decision: PipelineDecision;
  trace: PipelineEvent[];
  resumeCheckpoint?: PipelineResumeCheckpoint;
  specHistory: SpecHistoryEntry[];
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
  roundPlans: Map<number, StepPlan>;
}

interface RoundState {
  spec: string;
  blockers: Blocker[];
  hasMinorFindings: boolean;
  clean: boolean;
  unreviewed: boolean;
  degradedLow: boolean;
  highTierMissing: boolean;
  highTierAuthFailure: boolean;
  highTierExecuted: boolean;
  structural: StructuralCheck;
  postSections: string[];
}

interface StepPlan {
  expectedSteps: number;
  currentStep: number;
}

interface RoundMemory {
  round: number;
  status: string;
  blockers: string[];
  decision: string;
}

interface RetryPlan {
  retries: number;
  backoffMs: number;
}

interface SpecCandidate {
  spec: string;
  structural: StructuralCheck;
  blockerCount: number;
  source: string;
}

type RewriteTarget =
  | { provider: 'free'; model: string }
  | { provider: 'gemini'; model: string }
  | { provider: 'kimi'; model: string }
  | { provider: 'anthropic'; model: string };

function deriveErrorKindFromUnknown(err: unknown): ProviderErrorKind | undefined {
  if (err instanceof ProviderError) return err.kind;
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function applySanitize(ctx: StepContext, raw: string): string {
  const sanitized: SanitizeResult = sanitizeOutput(raw);
  let text = sanitized.text;
  if (sanitized.changed && sanitized.warning) {
    ctx.decision.sanitizeWarnings.push(sanitized.warning);
  }

  const stripped = stripReviewMetadataSections(text);
  if (stripped.removedMarkers.length > 0) {
    ctx.decision.containsReviewMetadata = true;
    ctx.decision.reviewMetadataMarkers = dedupeStrings([
      ...ctx.decision.reviewMetadataMarkers,
      ...stripped.removedMarkers,
    ]);
    ctx.decision.sanitizeWarnings.push(
      `Removed review metadata markers: ${stripped.removedMarkers.join(' | ')}`,
    );
    text = stripped.text;
  }

  return text;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
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

function addTokenUsage(
  ctx: StepContext,
  provider: string,
  model: string,
  usage: ProviderTokenUsage | undefined,
): void {
  if (!usage) return;
  const key = `${provider}:${model}`;
  const existing = ctx.decision.tokenUsage.byProviderModel[key] || {};
  ctx.decision.tokenUsage.byProviderModel[key] = {
    inputTokens: (existing.inputTokens || 0) + (usage.inputTokens || 0),
    outputTokens: (existing.outputTokens || 0) + (usage.outputTokens || 0),
    totalTokens: (existing.totalTokens || 0) + (usage.totalTokens || 0),
  };
  ctx.decision.tokenUsage.total = {
    inputTokens:
      (ctx.decision.tokenUsage.total.inputTokens || 0) + (usage.inputTokens || 0),
    outputTokens:
      (ctx.decision.tokenUsage.total.outputTokens || 0) + (usage.outputTokens || 0),
    totalTokens:
      (ctx.decision.tokenUsage.total.totalTokens || 0) + (usage.totalTokens || 0),
  };
}

function markTier(ctx: StepContext, tier: 1 | 2 | 3): void {
  if (!ctx.decision.tiersUsed.includes(tier)) ctx.decision.tiersUsed.push(tier);
}

function setRoundStepPlan(ctx: StepContext, round: number, expectedSteps: number): void {
  ctx.roundPlans.set(round, {
    expectedSteps,
    currentStep: 0,
  });
}

function nextStepProgress(
  ctx: StepContext,
  round: number,
): { stepIndex: number; expectedSteps: number } {
  const plan = ctx.roundPlans.get(round);
  if (!plan) {
    const fallback = { expectedSteps: 1, currentStep: 0 };
    ctx.roundPlans.set(round, fallback);
    fallback.currentStep += 1;
    return { stepIndex: fallback.currentStep, expectedSteps: fallback.expectedSteps };
  }
  plan.currentStep += 1;
  return { stepIndex: plan.currentStep, expectedSteps: plan.expectedSteps };
}

function computeExitCode(status: PipelineStatus): number {
  switch (status) {
    case 'STOPPED':
      return EXIT_CODES.stopped;
    case 'FAILED_BLOCKER':
    case 'FAILED_RUBRIC':
      return EXIT_CODES.failedBlocker;
    case 'QUOTA_EXHAUSTED':
      return EXIT_CODES.quotaExhausted;
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

class PipelineStoppedError extends Error {
  constructor(message = 'Pipeline stopped by caller.') {
    super(message);
    this.name = 'PipelineStoppedError';
  }
}

function throwIfStopped(ctx: StepContext, scope: string): void {
  if (ctx.input.abortSignal?.aborted) {
    throw new PipelineStoppedError(`Stop requested at ${scope}.`);
  }
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function clampGoalSummary(text: string): { text: string; truncatedAfterSummary: boolean } {
  let normalized = text.trim();
  let truncatedAfterSummary = false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > LIMITS.goalSummaryMaxWords) {
    normalized = words.slice(0, LIMITS.goalSummaryMaxWords).join(' ');
    truncatedAfterSummary = true;
  }
  if (normalized.length > LIMITS.goalMaxChars) {
    normalized = normalized.slice(0, LIMITS.goalMaxChars).trim();
    truncatedAfterSummary = true;
  }

  return { text: normalized, truncatedAfterSummary };
}

function buildGoalNormalizationPrompt(rawGoal: string): string {
  return [
    'You are normalizing raw multi-agent conversation logs into a concrete implementation goal.',
    `Output <= ${LIMITS.goalSummaryMaxWords} words.`,
    'Keep all technical requirements and constraints.',
    'Discard conversational artifacts, roleplay, insults, and duplicated commentary.',
    'Return plain text only.',
    '',
    'Raw input:',
    rawGoal,
  ].join('\n');
}

function summarizeCritique(raw: string): string {
  return trimApproxTokens(raw, LIMITS.critiqueSummaryTokens);
}

function parseRepairTemperature(): number {
  const raw = process.env.SPEC_REPAIR_TEMPERATURE;
  if (!raw) return 0.1;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 0.1;
  return Math.min(1, Math.max(0, parsed));
}

function estimateFreeCallsForRound(
  input: PipelineInput,
  policy: ProviderPolicy,
  resumeMode: boolean,
): number {
  if (!policy.allowOpenRouter || resumeMode) return 0;

  // Baseline free-route usage: free draft + free rewrite.
  let estimated = 2;

  // Conservative fallback when low tiers cannot run and rewrite path can fall back to free drafter.
  const lowTierMayFallBackToFree =
    input.mode !== 'free' && !policy.allowGemini && !policy.allowKimi;
  if (lowTierMayFallBackToFree) estimated += 1;

  return estimated;
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

function buildDecisionMemoryBlock(history: RoundMemory[]): string {
  if (history.length === 0) return '';
  const older = history.slice(0, -2);
  const recent = history.slice(-2);
  const lines: string[] = ['Decision memory from previous rounds (compact):'];
  for (const item of older) {
    lines.push(
      `- Round ${item.round}: ${item.status}; blockers=${item.blockers.length}; decision=${item.decision}`,
    );
  }
  for (const item of recent) {
    lines.push(`- Round ${item.round} (detailed):`);
    lines.push(`  - status: ${item.status}`);
    lines.push(`  - blockers: ${item.blockers.join(' | ') || 'none'}`);
    lines.push(`  - decision: ${item.decision}`);
  }
  return trimApproxTokens(lines.join('\n'), LIMITS.decisionMemoryTokens);
}

function buildPromptSharedContext(
  goal: string,
  userNotes: string | undefined,
  memoryBlock: string | undefined,
): string[] {
  const lines: string[] = [];
  lines.push(`Goal: ${goal}`);
  if (userNotes?.trim()) {
    lines.push('');
    lines.push('User notes on previous draft:');
    lines.push(userNotes.trim());
  }
  if (memoryBlock?.trim()) {
    lines.push('');
    lines.push(memoryBlock.trim());
  }
  return lines;
}

function buildDraftPrompt(
  goal: string,
  userNotes?: string,
  priorSpec?: string,
  memoryBlock?: string,
): string {
  const sharedContext = buildPromptSharedContext(goal, userNotes, memoryBlock);
  if (priorSpec?.trim()) {
    return [
      'Return ONLY final markdown.',
      'Start directly with `## Summary`.',
      'Output the FULL document; never return diffs, placeholders, or partial sections.',
      '',
      ...sharedContext,
      '',
      'Revise this existing implementation spec for clarity, feasibility, and correctness.',
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
    'Return ONLY final markdown.',
    'Start directly with `## Summary`.',
    'Output the FULL document; never return diffs, placeholders, or partial sections.',
    '',
    ...sharedContext,
    '',
    'You are writing an implementation specification for software engineers.',
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
    'You are an isolated architectural reviewer with NO filesystem/tool access.',
    'Do not cite files or line numbers.',
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
  userNotes: string | undefined,
  currentSpec: string,
  feedback: string,
  tierLabel: 'free' | 'low' | 'high',
  memoryBlock?: string,
): string {
  const sharedContext = buildPromptSharedContext(goal, userNotes, memoryBlock);
  return [
    'Return ONLY final markdown.',
    'Start directly with `## Summary`.',
    'Output the FULL document; never return diffs, placeholders, or partial sections.',
    '',
    ...sharedContext,
    '',
    `Revise this implementation spec after ${tierLabel.toUpperCase()} critique.`,
    '',
    'Priorities:',
    '- Resolve blockers and holes first.',
    '- Preserve useful MVP and Pareto improvements.',
    '- Do not churn style-only items unless they remove ambiguity.',
    '- If recommendations conflict, choose lower-risk path and state the choice and rationale.',
    '- Output only the revised implementation spec.',
    '- Do not include reviewer verdicts/metadata or review process commentary.',
    '- Do not echo critique text verbatim.',
    '',
    'Critique feedback:',
    feedback,
    '',
    'Current spec:',
    currentSpec,
    '',
    'Return markdown with required sections:',
    '## Summary',
    '## Architecture',
    '## Implementation Changes',
    '## Test Plan',
    '## Risks',
  ].join('\n');
}

function buildRepairPrompt(
  goal: string,
  userNotes: string | undefined,
  currentSpec: string,
  missingSections: string[],
  tierLabel: 'free' | 'low' | 'high',
  memoryBlock?: string,
): string {
  const sharedContext = buildPromptSharedContext(goal, userNotes, memoryBlock);
  return [
    'Return ONLY final markdown.',
    'Start directly with `## Summary`.',
    'Rewrite ENTIRE document from `## Summary` through `## Risks`.',
    'Preserve existing valid content.',
    '',
    ...sharedContext,
    '',
    `Tier: ${tierLabel.toUpperCase()}`,
    `Missing sections: ${missingSections.join(', ')}`,
    '',
    'Current spec:',
    currentSpec,
  ].join('\n');
}

function buildCompactPrompt(
  goal: string,
  userNotes: string | undefined,
  currentSpec: string,
  budgetTokens: number,
  tierLabel: 'free' | 'low' | 'high',
  memoryBlock?: string,
): string {
  const sharedContext = buildPromptSharedContext(goal, userNotes, memoryBlock);
  return [
    'Return ONLY final markdown.',
    'Start directly with `## Summary`.',
    'Output the FULL document; never return diffs, placeholders, or partial sections.',
    '',
    ...sharedContext,
    '',
    `Tier: ${tierLabel.toUpperCase()}`,
    `Target under ${budgetTokens} tokens.`,
    '',
    'Compaction rules:',
    '- Convert prose to bullets.',
    '- Remove redundancy.',
    '- Preserve all required sections and code blocks.',
    '',
    'Current spec:',
    currentSpec,
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

function getRetryPlan(err: unknown): RetryPlan {
  if (err instanceof ProviderAuthError) return { retries: 0, backoffMs: 0 };
  if (err instanceof ProviderTimeoutError) return { retries: 1, backoffMs: 0 };
  if (err instanceof ProviderNetworkError) return { retries: 1, backoffMs: 500 };
  if (err instanceof ProviderParseError) return { retries: 1, backoffMs: 0 };
  if (err instanceof ProviderEmptyError) return { retries: 1, backoffMs: 0 };
  return { retries: 0, backoffMs: 0 };
}

function chooseBestCandidate(candidates: SpecCandidate[]): SpecCandidate {
  if (candidates.length === 0) {
    return {
      spec: '',
      structural: structuralRubric(''),
      blockerCount: Number.MAX_SAFE_INTEGER,
      source: 'empty',
    };
  }
  return [...candidates].sort((a, b) => {
    const missingA = a.structural.missing.length;
    const missingB = b.structural.missing.length;
    if (missingA !== missingB) return missingA - missingB;
    if (a.blockerCount !== b.blockerCount) return a.blockerCount - b.blockerCount;
    return b.spec.length - a.spec.length;
  })[0];
}

async function runStep<
  T extends { text?: string; raw?: string; usage?: ProviderTokenUsage },
>(
  ctx: StepContext,
  config: {
    round: number;
    step: string;
    provider: string;
    model: string;
    prompt: string;
    attempt: number;
    progress: { stepIndex: number; expectedSteps: number };
    call: () => Promise<T>;
  },
): Promise<T> {
  throwIfStopped(ctx, `${config.step}:before_dispatch`);
  emitEvent(ctx, {
    type: 'step_start',
    ts: nowIso(),
    round: config.round,
    step: config.step,
    provider: config.provider,
    model: config.model,
    prompt: config.prompt,
    meta: { ...config.progress, attempt: config.attempt },
  });
  const started = Date.now();
  try {
    const result = await config.call();
    addTokenUsage(ctx, config.provider, config.model, result.usage);
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
      meta: { ...config.progress, attempt: config.attempt },
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
      meta: { ...config.progress, attempt: config.attempt },
    });
    throw err;
  }
}

async function runStepWithRetry<
  T extends { text?: string; raw?: string; usage?: ProviderTokenUsage },
>(
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
  let attempt = 1;
  let lastError: unknown;
  const progress = nextStepProgress(ctx, config.round);
  while (true) {
    throwIfStopped(ctx, `${config.step}:retry_${attempt}`);
    try {
      return await runStep(ctx, {
        ...config,
        attempt,
        progress,
      });
    } catch (err) {
      lastError = err;
      const retryPlan = getRetryPlan(err);
      if (attempt > retryPlan.retries) break;
      attempt += 1;
      if (retryPlan.backoffMs > 0) await sleep(retryPlan.backoffMs);
    }
  }
  throw lastError;
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
    call: () => Promise<ProviderResult>;
  },
): Promise<CriticRun> {
  try {
    registerCall(ctx, `${config.provider}:${config.model}`);
    const response = await runStepWithRetry(ctx, {
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
    const errorKind = err instanceof ProviderError ? err.kind : undefined;
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
      errorKind,
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
  stepName: string,
  temperature = 0.2,
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
        return await runStepWithRetry(ctx, {
          round,
          step: `${stepName}_qwen`,
          provider: 'openrouter',
          model: ctx.models.freeDrafter,
          prompt,
          call: async () =>
            await callOpenRouter([{ role: 'user', content: prompt }], {
              model: ctx.models.freeDrafter,
              maxOutputTokens: LIMITS.draftTokens,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature,
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
        return await runStepWithRetry(ctx, {
          round,
          step: `${stepName}_gemini_fallback`,
          provider: 'gemini',
          model: ctx.models.geminiFreeCritic,
          prompt,
          call: async () =>
            await callGemini(prompt, {
              modelOverride: ctx.models.geminiFreeCritic,
              maxOutputTokens: LIMITS.draftTokens,
              timeoutMs: LIMITS.perCallTimeoutMs,
              temperature,
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

async function normalizeGoal(
  ctx: StepContext,
  rawGoal: string,
): Promise<{ normalizedGoal: string; summarizerProviderModel?: string }> {
  if (rawGoal.length <= LIMITS.goalMaxChars) {
    return { normalizedGoal: rawGoal.trim() || rawGoal };
  }

  const prompt = buildGoalNormalizationPrompt(rawGoal);
  const summarized = await draftWithFreePipeline(
    ctx,
    0,
    prompt,
    'goal_normalize',
    0.1,
  );
  const clamped = clampGoalSummary(summarized.text);

  ctx.decision.goalNormalization = {
    summarized: true,
    rawChars: rawGoal.length,
    normalizedChars: clamped.text.length,
    summarizerProviderModel: `${summarized.provider}:${summarized.model}`,
    truncatedAfterSummary: clamped.truncatedAfterSummary,
  };
  ctx.decision.notes.push(
    `Goal normalization applied (${rawGoal.length} -> ${clamped.text.length} chars).`,
  );

  return {
    normalizedGoal: clamped.text,
    summarizerProviderModel: `${summarized.provider}:${summarized.model}`,
  };
}

function makeRewriteCall(
  ctx: StepContext,
  round: number,
  target: RewriteTarget,
): (prompt: string, step: string, temperature: number) => Promise<ProviderResult> {
  return async (prompt: string, step: string, temperature: number) => {
    if (target.provider === 'free') {
      return await draftWithFreePipeline(ctx, round, prompt, step, temperature);
    }
    if (target.provider === 'gemini') {
      registerCall(ctx, `gemini:${target.model}`);
      return await runStepWithRetry(ctx, {
        round,
        step,
        provider: 'gemini',
        model: target.model,
        prompt,
        call: async () =>
          await callGemini(prompt, {
            modelOverride: target.model,
            maxOutputTokens: LIMITS.draftTokens,
            timeoutMs: LIMITS.perCallTimeoutMs,
            temperature,
          }),
      });
    }
    if (target.provider === 'kimi') {
      registerCall(ctx, `kimi:${target.model}`);
      return await runStepWithRetry(ctx, {
        round,
        step,
        provider: 'kimi',
        model: target.model,
        prompt,
        call: async () =>
          await callKimi(prompt, {
            modelOverride: target.model,
            maxOutputTokens: LIMITS.draftTokens,
            timeoutMs: LIMITS.perCallTimeoutMs,
            temperature,
          }),
      });
    }
    registerCall(ctx, `anthropic:${target.model}`);
    return await runStepWithRetry(ctx, {
      round,
      step,
      provider: 'anthropic',
      model: target.model,
      prompt,
      call: async () =>
        await callAnthropic(prompt, {
          model: target.model,
          maxOutputTokens: LIMITS.draftTokens,
          timeoutMs: LIMITS.perCallTimeoutMs,
          temperature,
        }),
    });
  };
}

function resolveLowRewriteTarget(
  ctx: StepContext,
  lowRuns: CriticRun[],
  fallbackTarget: RewriteTarget,
): RewriteTarget {
  const preferredProvider =
    lowRuns.find((run) => run.available && run.provider === 'kimi')?.provider ||
    lowRuns.find((run) => run.available && run.provider === 'gemini')?.provider;

  if (preferredProvider === 'kimi') {
    return { provider: 'kimi', model: ctx.models.kimiLowCritic };
  }
  if (preferredProvider === 'gemini') {
    return { provider: 'gemini', model: ctx.models.geminiLowCritic };
  }
  return fallbackTarget;
}

async function compactSpecBeforeCriticIfNeeded(
  ctx: StepContext,
  config: {
    round: number;
    goal: string;
    userNotes?: string;
    memoryBlock?: string;
    spec: string;
    tierLabel: 'free' | 'low' | 'high';
    rewriteCall: (prompt: string, step: string, temperature: number) => Promise<ProviderResult>;
  },
): Promise<string> {
  if (estimateTokens(config.spec) <= LIMITS.critiqueSpecTokens) {
    return config.spec;
  }
  pushNote(
    ctx,
    `Round ${config.round}: pre-critic compaction applied for ${config.tierLabel.toUpperCase()} stage.`,
  );
  const compactPrompt = buildCompactPrompt(
    config.goal,
    config.userNotes,
    config.spec,
    LIMITS.critiqueSpecTokens,
    config.tierLabel,
    config.memoryBlock,
  );
  const repaired = await config.rewriteCall(
    compactPrompt,
    `${config.tierLabel}_precritic_compact`,
    parseRepairTemperature(),
  );
  return applySanitize(ctx, repaired.text);
}

async function runRepairAndCompaction(
  ctx: StepContext,
  config: {
    round: number;
    goal: string;
    userNotes?: string;
    memoryBlock?: string;
    initialSpec: string;
    blockerCount: number;
    tierLabel: 'free' | 'low' | 'high';
    rewriteStepPrefix: string;
    repairTemperature: number;
    rewriteCall: (prompt: string, step: string, temperature: number) => Promise<ProviderResult>;
  },
): Promise<{ spec: string; structural: StructuralCheck; repaired: boolean; compacted: boolean }> {
  const candidates: SpecCandidate[] = [];
  const initial = applySanitize(ctx, config.initialSpec);
  candidates.push({
    spec: initial,
    structural: structuralRubric(initial),
    blockerCount: config.blockerCount,
    source: 'initial',
  });

  let best = chooseBestCandidate(candidates);
  let repaired = false;
  let compacted = false;

  if (best.structural.passed && estimateTokens(best.spec) <= LIMITS.draftTokens) {
    return {
      spec: best.spec,
      structural: best.structural,
      repaired,
      compacted,
    };
  }

  for (let attempt = 1; attempt <= LIMITS.repairAttempts; attempt += 1) {
    if (best.structural.passed) break;
    const repairPrompt = buildRepairPrompt(
      config.goal,
      config.userNotes,
      best.spec,
      best.structural.missing,
      config.tierLabel,
      config.memoryBlock,
    );
    const repairedResult = await config.rewriteCall(
      repairPrompt,
      `${config.rewriteStepPrefix}_repair_${attempt}`,
      config.repairTemperature,
    );
    const repairedText = applySanitize(ctx, repairedResult.text);
    candidates.push({
      spec: repairedText,
      structural: structuralRubric(repairedText),
      blockerCount: config.blockerCount,
      source: `repair-${attempt}`,
    });
    best = chooseBestCandidate(candidates);
    repaired = true;
  }

  for (let attempt = 1; attempt <= LIMITS.compactAttempts; attempt += 1) {
    if (estimateTokens(best.spec) <= LIMITS.draftTokens) break;
    const compactPrompt = buildCompactPrompt(
      config.goal,
      config.userNotes,
      best.spec,
      LIMITS.draftTokens,
      config.tierLabel,
      config.memoryBlock,
    );
    const compactResult = await config.rewriteCall(
      compactPrompt,
      `${config.rewriteStepPrefix}_compact_${attempt}`,
      config.repairTemperature,
    );
    const compactText = applySanitize(ctx, compactResult.text);
    candidates.push({
      spec: compactText,
      structural: structuralRubric(compactText),
      blockerCount: config.blockerCount,
      source: `compact-${attempt}`,
    });
    best = chooseBestCandidate(candidates);
    compacted = true;
  }

  return {
    spec: best.spec,
    structural: best.structural,
    repaired,
    compacted,
  };
}

async function runFreeRound(
  ctx: StepContext,
  round: number,
  goal: string,
  memoryBlock: string,
  seedSpec?: string,
): Promise<RoundState> {
  if (!ctx.roundPlans.has(round)) {
    setRoundStepPlan(ctx, round, 8);
  }
  markTier(ctx, 1);
  const roundStart = Date.now();
  const draftPrompt = buildDraftPrompt(goal, ctx.input.userNotes, seedSpec, memoryBlock);
  const draft = await draftWithFreePipeline(ctx, round, draftPrompt, 'free_draft');
  let spec = applySanitize(ctx, draft.text);
  pushNote(ctx, `Round ${round}: free draft by ${draft.provider}/${draft.model}`);
  const repairTemperature = parseRepairTemperature();
  const freeRewriteCall = makeRewriteCall(ctx, round, {
    provider: 'free',
    model: ctx.models.freeDrafter,
  });
  spec = await compactSpecBeforeCriticIfNeeded(ctx, {
    round,
    goal,
    userNotes: ctx.input.userNotes,
    memoryBlock,
    spec,
    tierLabel: 'free',
    rewriteCall: freeRewriteCall,
  });

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
  const blocking = collectBlocking(criticRuns);
  if (criticRuns.length === 0 || criticRuns.every((run) => !run.available)) {
    unreviewed = true;
    ctx.decision.degraded = true;
    pushNote(ctx, 'Free round critics unavailable. Round marked UNREVIEWED.');
  } else if (Date.now() - roundStart > LIMITS.freeRoundBudgetMs) {
    pushNote(ctx, `Round ${round}: FREE stage reached budget ceiling before rewrite.`);
  } else {
    const critiqueSummary = criticRuns
      .filter((run) => run.available)
      .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
      .join('\n\n');
    const rewritePrompt = buildRewritePrompt(
      goal,
      ctx.input.userNotes,
      spec,
      critiqueSummary,
      'free',
      memoryBlock,
    );
    const rewrite = await freeRewriteCall(rewritePrompt, 'free_rewrite', 0.2);
    spec = applySanitize(ctx, rewrite.text);
  }

  const preRepairStructural = structuralRubric(spec);
  const needsRepairOrCompact =
    !preRepairStructural.passed || estimateTokens(spec) > LIMITS.draftTokens;
  const repairResult = needsRepairOrCompact
    ? await runRepairAndCompaction(ctx, {
        round,
        goal,
        userNotes: ctx.input.userNotes,
        memoryBlock,
        initialSpec: spec,
        blockerCount: blocking.length,
        tierLabel: 'free',
        rewriteStepPrefix: 'free_postfix',
        repairTemperature,
        rewriteCall: freeRewriteCall,
      })
    : {
        spec,
        structural: preRepairStructural,
        repaired: false,
        compacted: false,
      };
  spec = repairResult.spec;

  const hasMinor = hasMinorFindings(criticRuns);
  const structural = repairResult.structural;
  const clean =
    !unreviewed &&
    criticRuns.length > 0 &&
    blocking.length === 0 &&
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
    highTierAuthFailure: false,
    highTierExecuted: false,
    structural,
    postSections: criticRuns.map((run) => toReviewMarkdown(run)),
  };
}

async function runFreeLowRound(
  ctx: StepContext,
  round: number,
  goal: string,
  memoryBlock: string,
  seedSpec?: string,
): Promise<RoundState> {
  setRoundStepPlan(ctx, round, 12);
  const roundStart = Date.now();
  const free = await runFreeRound(ctx, round, goal, memoryBlock, seedSpec);
  let spec = free.spec;
  const allSections = [...free.postSections];
  const lowRuns: CriticRun[] = [];
  let degradedLow = false;
  const repairTemperature = parseRepairTemperature();

  markTier(ctx, 2);
  if (Date.now() - roundStart > LIMITS.freeLowRoundBudgetMs) {
    degradedLow = true;
    ctx.decision.degraded = true;
    ctx.decision.degradedLow = true;
    pushNote(ctx, 'Low-tier skipped due to FREE+LOW budget ceiling.');
    return {
      ...free,
      degradedLow,
    };
  }
  const lowPreferredTarget: RewriteTarget =
    ctx.policy.allowKimi
      ? { provider: 'kimi', model: ctx.models.kimiLowCritic }
      : ctx.policy.allowGemini
        ? { provider: 'gemini', model: ctx.models.geminiLowCritic }
        : { provider: 'free', model: ctx.models.freeDrafter };
  const lowPreCriticRewriteCall = makeRewriteCall(ctx, round, lowPreferredTarget);
  spec = await compactSpecBeforeCriticIfNeeded(ctx, {
    round,
    goal,
    userNotes: ctx.input.userNotes,
    memoryBlock,
    spec,
    tierLabel: 'low',
    rewriteCall: lowPreCriticRewriteCall,
  });
  const lowPrompt = buildCriticPrompt(
    goal,
    spec,
    'Security, edge cases, and reliability blockers.',
  );
  const lowCriticPromises: Array<Promise<CriticRun>> = [];
  if (ctx.policy.allowKimi) {
    lowCriticPromises.push(
      runCritic(ctx, {
        round,
        step: 'low_critic_kimi',
        critic: 'LowCriticKimi',
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
      }),
    );
  }
  if (ctx.policy.allowGemini) {
    lowCriticPromises.push(
      runCritic(ctx, {
        round,
        step: 'low_critic_gemini',
        critic: 'LowCriticGemini',
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
      }),
    );
  }
  if (lowCriticPromises.length > 0) {
    const settled = await Promise.allSettled(lowCriticPromises);
    settled.forEach((item, idx) => {
      if (item.status === 'fulfilled') {
        lowRuns.push(item.value);
      } else {
        const criticLabel =
          lowCriticPromises.length > 1
            ? idx === 0
              ? 'LowCritic[0]'
              : 'LowCritic[1]'
            : 'LowCritic';
        pushNote(
          ctx,
          `${criticLabel} promise rejected unexpectedly: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`,
        );
      }
    });
  } else {
    pushNote(ctx, 'No low-tier critic promises were scheduled.');
  }

  const lowRewriteTarget = resolveLowRewriteTarget(ctx, lowRuns, lowPreferredTarget);
  const lowRewriteCall = makeRewriteCall(ctx, round, lowRewriteTarget);

  if (lowRuns.length === 0 || lowRuns.every((run) => !run.available)) {
    degradedLow = true;
    ctx.decision.degraded = true;
    ctx.decision.degradedLow = true;
    pushNote(ctx, 'Low-tier critics unavailable. Returning FREE result as DEGRADED_LOW.');
  } else {
    if (lowRuns.filter((run) => run.available).length === 1) {
      degradedLow = true;
      ctx.decision.degraded = true;
      ctx.decision.degradedLow = true;
      pushNote(ctx, 'Low-tier executed with a single critic (degraded).');
    }
    const lowSummary = lowRuns
      .filter((run) => run.available)
      .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
      .join('\n\n');
    if (Date.now() - roundStart > LIMITS.freeLowRoundBudgetMs) {
      degradedLow = true;
      pushNote(ctx, 'Low-tier rewrite skipped due to FREE+LOW budget ceiling.');
    } else {
      const rewritePrompt = buildRewritePrompt(
        goal,
        ctx.input.userNotes,
        spec,
        lowSummary,
        'low',
        memoryBlock,
      );
      const revised = await lowRewriteCall(
        rewritePrompt,
        `low_rewrite_${lowRewriteTarget.provider}`,
        0.2,
      );
      spec = applySanitize(ctx, revised.text);
    }
  }

  const combinedBlocking = dedupeBlockers([...free.blockers, ...collectBlocking(lowRuns)]);

  const preRepairStructural = structuralRubric(spec);
  const needsRepairOrCompact =
    !preRepairStructural.passed || estimateTokens(spec) > LIMITS.draftTokens;
  const repairResult = needsRepairOrCompact
    ? await runRepairAndCompaction(ctx, {
        round,
        goal,
        userNotes: ctx.input.userNotes,
        memoryBlock,
        initialSpec: spec,
        blockerCount: combinedBlocking.length,
        tierLabel: 'low',
        rewriteStepPrefix: 'low_postfix',
        repairTemperature,
        rewriteCall: lowRewriteCall,
      })
    : {
        spec,
        structural: preRepairStructural,
        repaired: false,
        compacted: false,
      };
  spec = repairResult.spec;
  const hasMinor = free.hasMinorFindings || hasMinorFindings(lowRuns);
  const structural = repairResult.structural;
  const clean =
    free.clean &&
    !degradedLow &&
    combinedBlocking.length === 0 &&
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
    highTierAuthFailure: false,
    highTierExecuted: false,
    structural,
    postSections: allSections,
  };
}

async function runHighTierFromBase(
  ctx: StepContext,
  round: number,
  goal: string,
  memoryBlock: string,
  base: RoundState,
): Promise<RoundState> {
  const roundStart = Date.now();
  let spec = base.spec;
  const sections = [...base.postSections];
  let highTierMissing = false;
  let highTierAuthFailure = false;
  let highTierExecuted = false;
  const repairTemperature = parseRepairTemperature();

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
    return {
      ...base,
      clean: false,
      highTierMissing,
      highTierAuthFailure,
      highTierExecuted,
    };
  }

  markTier(ctx, 3);
  highTierExecuted = true;
  const highRewriteCall = makeRewriteCall(ctx, round, {
    provider: 'anthropic',
    model: ctx.models.sonnet,
  });
  spec = await compactSpecBeforeCriticIfNeeded(ctx, {
    round,
    goal,
    userNotes: ctx.input.userNotes,
    memoryBlock,
    spec,
    tierLabel: 'high',
    rewriteCall: highRewriteCall,
  });

  const codexPrompt = buildCriticPrompt(
    goal,
    spec,
    'Implementation feasibility blockers and test coverage gaps only.',
  );
  const claudeCriticPrompt = buildCriticPrompt(
    goal,
    spec,
    'Architecture and long-term maintainability blockers.',
  );
  const criticResults = await Promise.allSettled([
    runCritic(ctx, {
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
    }),
    runCritic(ctx, {
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
    }),
  ]);
  const highRuns: CriticRun[] = [];
  criticResults.forEach((result, index) => {
    const criticName = index === 0 ? 'CodexCritic' : 'ClaudeCritic';
    const criticProvider = index === 0 ? 'openrouter' : 'anthropic';
    const criticModel = index === 0 ? ctx.models.codexCritic : ctx.models.opus;
    if (result.status === 'fulfilled') {
      highRuns.push(result.value);
    } else {
      const errorText =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      const errorKind = deriveErrorKindFromUnknown(result.reason);
      highRuns.push({
        critic: criticName,
        provider: criticProvider,
        model: criticModel,
        tier: 3,
        available: false,
        structured: false,
        timedOut: errorKind === 'timeout',
        parse: {
          assessment: 'UNSTRUCTURED',
          blockers: [],
          structured: false,
          error: 'promise_rejected',
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
        errorKind,
        error: errorText,
      });
      pushNote(
        ctx,
        `${criticName} promise rejected unexpectedly: ${errorText}`,
      );
    }
  });
  const codexCritic =
    highRuns.find((run) => run.critic === 'CodexCritic') ||
    ({
      critic: 'CodexCritic',
      provider: 'openrouter',
      model: ctx.models.codexCritic,
      tier: 3,
      available: false,
      structured: false,
      timedOut: false,
      parse: { assessment: 'UNSTRUCTURED', blockers: [], structured: false, error: 'missing' },
      narrative: { agreements: [], disagreements: [], holes: [], styleOnly: [], mvp: [], pareto: [] },
      raw: '',
    } as CriticRun);
  const claudeCritic =
    highRuns.find((run) => run.critic === 'ClaudeCritic') ||
    ({
      critic: 'ClaudeCritic',
      provider: 'anthropic',
      model: ctx.models.opus,
      tier: 3,
      available: false,
      structured: false,
      timedOut: false,
      parse: { assessment: 'UNSTRUCTURED', blockers: [], structured: false, error: 'missing' },
      narrative: { agreements: [], disagreements: [], holes: [], styleOnly: [], mvp: [], pareto: [] },
      raw: '',
    } as CriticRun);

  if (highRuns.filter((run) => run.available).length === 0) {
    highTierMissing = true;
    highTierAuthFailure =
      highRuns.some((run) => run.errorKind === 'auth') ||
      codexCritic.errorKind === 'auth' ||
      claudeCritic.errorKind === 'auth';
    pushNote(
      ctx,
      highTierAuthFailure
        ? 'High-tier auth failed; returning low-tier checkpoint result.'
        : 'High-tier critics unavailable; skipping high-tier rewrite and returning low-tier checkpoint result.',
    );
    return {
      ...base,
      clean: false,
      highTierMissing,
      highTierAuthFailure,
      highTierExecuted,
    };
  }

  const highSummary = highRuns
    .filter((run) => run.available)
    .map((run) => `### ${run.critic}\n${summarizeCritique(run.raw)}`)
    .join('\n\n');

  const rewritePrompt = buildRewritePrompt(
    goal,
    ctx.input.userNotes,
    spec,
    highSummary,
    'high',
    memoryBlock,
  );
  try {
    const rewritten = await highRewriteCall(rewritePrompt, 'high_rewrite_claude', 0.2);
    spec = applySanitize(ctx, rewritten.text);
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      highTierMissing = true;
      highTierAuthFailure = true;
      pushNote(ctx, 'High-tier rewrite auth failed; returning low-tier checkpoint result.');
      return {
        ...base,
        clean: false,
        highTierMissing,
        highTierAuthFailure,
        highTierExecuted,
      };
    }
    throw err;
  }

  const blockers = dedupeBlockers([...base.blockers, ...collectBlocking(highRuns)]);
  const preRepairStructural = structuralRubric(spec);
  const needsRepairOrCompact =
    !preRepairStructural.passed || estimateTokens(spec) > LIMITS.draftTokens;
  const repairResult = needsRepairOrCompact
    ? await runRepairAndCompaction(ctx, {
        round,
        goal,
        userNotes: ctx.input.userNotes,
        memoryBlock,
        initialSpec: spec,
        blockerCount: blockers.length,
        tierLabel: 'high',
        rewriteStepPrefix: 'high_postfix',
        repairTemperature,
        rewriteCall: highRewriteCall,
      })
    : {
        spec,
        structural: preRepairStructural,
        repaired: false,
        compacted: false,
      };
  spec = repairResult.spec;

  const hasMinor = base.hasMinorFindings || hasMinorFindings(highRuns);
  const structural = repairResult.structural;
  const clean = base.clean && blockers.length === 0 && structural.passed;

  sections.push(toReviewMarkdown(codexCritic), toReviewMarkdown(claudeCritic));
  if (Date.now() - roundStart > LIMITS.debateRoundBudgetMs) {
    pushNote(ctx, `Round ${round}: DEBATE stage exceeded target budget.`);
  }

  return {
    spec,
    blockers,
    hasMinorFindings: hasMinor,
    clean,
    unreviewed: base.unreviewed,
    degradedLow: base.degradedLow,
    highTierMissing,
    highTierAuthFailure,
    highTierExecuted,
    structural,
    postSections: sections,
  };
}

async function runDebateRound(
  ctx: StepContext,
  round: number,
  goal: string,
  memoryBlock: string,
  seedSpec?: string,
): Promise<RoundState> {
  setRoundStepPlan(ctx, round, 12);
  const low = await runFreeLowRound(ctx, round, goal, memoryBlock, seedSpec);
  return await runHighTierFromBase(ctx, round, goal, memoryBlock, low);
}

async function runDebateHighOnlyRound(
  ctx: StepContext,
  round: number,
  goal: string,
  memoryBlock: string,
  checkpoint: PipelineResumeCheckpoint,
): Promise<RoundState> {
  setRoundStepPlan(ctx, round, 5);
  const base: RoundState = {
    spec: checkpoint.spec,
    blockers: checkpoint.blockers,
    hasMinorFindings: false,
    clean: checkpoint.blockers.length === 0 && checkpoint.structural.passed,
    unreviewed: false,
    degradedLow: false,
    highTierMissing: false,
    highTierAuthFailure: false,
    highTierExecuted: false,
    structural: checkpoint.structural,
    postSections: checkpoint.postSections,
  };
  return await runHighTierFromBase(ctx, round, goal, memoryBlock, base);
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
    .filter(([key]) => {
      const splitAt = key.indexOf(':');
      if (splitAt <= 0) return false;
      const provider = key.slice(0, splitAt).toLowerCase();
      const model = key.slice(splitAt + 1).toLowerCase();
      return provider === 'openrouter' && model.endsWith(':free');
    })
    .reduce((sum, [, count]) => sum + count, 0);
}

export const PIPELINE_TEST_ONLY = {
  estimateFreeCallsForRound,
  countFreeCalls,
  buildRewritePrompt,
  clampGoalSummary,
  buildGoalNormalizationPrompt,
};

function initDecision(input: PipelineInput): PipelineDecision {
  const parsedDailyLimit = Number.parseInt(process.env.SPEC_FREE_PROMPT_DAILY_LIMIT || '50', 10);
  const dailyLimit = Number.isFinite(parsedDailyLimit) ? Math.max(0, parsedDailyLimit) : 50;
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
      containsReviewMetadata: false,
      reviewMetadataMarkers: [],
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
    goalNormalization: {
      summarized: false,
      rawChars: input.goal.length,
      normalizedChars: input.goal.length,
      truncatedAfterSummary: false,
    },
    containsReviewMetadata: false,
    reviewMetadataMarkers: [],
    freePromptUsage: {
      used: 0,
      dailyLimit,
      nearLimit: false,
    },
    costEstimateUsd: 0,
    resumeFrom: null,
    checkpointPath: null,
    sanitizeWarnings: [],
    cliCapabilities: {},
    tokenUsage: {
      total: {},
      byProviderModel: {},
    },
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
    roundPlans: new Map<number, StepPlan>(),
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
  let resumeCheckpoint: PipelineResumeCheckpoint | undefined;
  const roundMemory: RoundMemory[] = [];
  const specHistory: SpecHistoryEntry[] = [];
  let quotaExhausted = false;

  try {
    throwIfStopped(ctx, 'pipeline:start');
    if (!policy.allowOpenRouter && !policy.allowGemini) {
      throw new Error(
        'No drafter available. Configure OpenRouter free route or Gemini.',
      );
    }

    const repeat = Math.max(1, Math.min(10, input.repeat));
    const rawGoal = input.goal;
    const goalNormalizationResult = await normalizeGoal(ctx, rawGoal);
    const normalizedGoal = goalNormalizationResult.normalizedGoal;
    decision.goal = normalizedGoal;
    if (!decision.goalNormalization.summarized) {
      const clamped = clampGoalSummary(normalizedGoal);
      decision.goalNormalization = {
        summarized: false,
        rawChars: rawGoal.length,
        normalizedChars: clamped.text.length,
        truncatedAfterSummary: false,
      };
    }

    let seedSpec: string | undefined;
    const resumeMode = Boolean(input.resumeCheckpoint && input.mode === 'debate');
    if (resumeMode) {
      seedSpec = input.resumeCheckpoint?.spec;
      finalSpec = seedSpec || '';
      pushNote(ctx, 'Resuming from checkpoint: skipping free/free+low and running high tier.');
    }

    for (let round = 1; round <= repeat; round += 1) {
      throwIfStopped(ctx, `round_${round}:before_start`);
      const freeUsed = countFreeCalls(decision.callCounts);
      const projectedFree = freeUsed + estimateFreeCallsForRound(input, policy, resumeMode);
      if (projectedFree > decision.freePromptUsage.dailyLimit) {
        quotaExhausted = true;
        decision.convergenceReason = 'QUOTA_EXHAUSTED';
        pushNote(
          ctx,
          `Free-tier quota exhausted before round ${round}: projected ${projectedFree}/${decision.freePromptUsage.dailyLimit}.`,
        );
        break;
      }
      const stageStart = Date.now();
      const memoryBlock = buildDecisionMemoryBlock(roundMemory);
      let roundState: RoundState;
      if (input.mode === 'free') {
        roundState = await runFreeRound(ctx, round, normalizedGoal, memoryBlock, seedSpec);
        decision.timingMs.free += Date.now() - stageStart;
      } else if (input.mode === 'free+low') {
        roundState = await runFreeLowRound(
          ctx,
          round,
          normalizedGoal,
          memoryBlock,
          seedSpec,
        );
        decision.timingMs.low += Date.now() - stageStart;
      } else if (resumeMode) {
        roundState = await runDebateHighOnlyRound(
          ctx,
          round,
          normalizedGoal,
          memoryBlock,
          input.resumeCheckpoint!,
        );
        decision.timingMs.high += Date.now() - stageStart;
      } else {
        roundState = await runDebateRound(
          ctx,
          round,
          normalizedGoal,
          memoryBlock,
          seedSpec,
        );
        decision.timingMs.high += Date.now() - stageStart;
      }

      finalSpec = roundState.spec;
      decision.structural = roundState.structural;
      decision.containsReviewMetadata =
        decision.containsReviewMetadata || roundState.structural.containsReviewMetadata;
      decision.reviewMetadataMarkers = dedupeStrings([
        ...decision.reviewMetadataMarkers,
        ...roundState.structural.reviewMetadataMarkers,
      ]);
      decision.unresolvedBlocking = roundState.blockers;
      decision.repeatRoundsUsed = round;
      decision.degradedLow = decision.degradedLow || roundState.degradedLow;
      decision.degraded = decision.degraded || roundState.unreviewed || roundState.degradedLow;
      seedSpec = finalSpec;
      lastRound = roundState;
      roundMemory.push({
        round,
        status: roundState.clean ? 'clean' : 'needs_changes',
        blockers: roundState.blockers.map((b) => `${b.id}: ${b.description}`),
        decision:
          roundState.clean
            ? 'Kept current approach and stopped early on convergence.'
            : 'Refine unresolved blockers and maintain required sections.',
      });
      specHistory.push({
        round,
        mode: input.mode,
        spec: finalSpec,
        blockers: roundState.blockers.length,
        structuralPassed: roundState.structural.passed,
      });

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
          roundsRequested: repeat,
          roundsExecuted: round,
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
              : !roundState.structural.passed
                ? 'FAILED_RUBRIC'
              : roundState.blockers.length > 0
                ? 'BLOCKING'
                : 'MAX_REPEAT';
      }
    }

    if (!lastRound && !quotaExhausted) throw new Error('Pipeline ended without producing a round.');

    if (quotaExhausted) {
      decision.status = 'QUOTA_EXHAUSTED';
    } else if (lastRound?.unreviewed) {
      decision.status = 'UNREVIEWED';
    } else if (
      lastRound &&
      input.mode === 'debate' &&
      (lastRound.highTierMissing || lastRound.highTierAuthFailure)
    ) {
      decision.status = 'NO_HIGH_TIER';
      decision.resumeFrom = 'high';
      resumeCheckpoint = {
        goal: normalizedGoal,
        spec: finalSpec,
        blockers: decision.unresolvedBlocking,
        structural: decision.structural,
        postSections: lastRound.postSections,
      };
    } else if (!decision.structural.passed) {
      decision.status = 'FAILED_RUBRIC';
      decision.convergenceReason = 'FAILED_RUBRIC';
      pushNote(
        ctx,
        `Structural rubric failed: ${decision.structural.missing.join(', ')}`,
      );
    } else if (decision.unresolvedBlocking.length > 0) {
      if (input.mode === 'debate' && !input.allowTier3) {
        decision.status = 'ESCALATION_REQUIRED';
      } else if (input.mode === 'debate' && lastRound?.highTierExecuted) {
        decision.status = 'FAILED_EXPENSIVE';
      } else {
        decision.status = 'FAILED_BLOCKER';
      }
    } else if (decision.degradedLow) {
      decision.status = 'DEGRADED_LOW';
    } else if (lastRound?.hasMinorFindings) {
      decision.status = 'REVIEWED_WITH_MINORS';
    } else {
      decision.status = 'REVIEWED';
    }

    postReview = (lastRound?.postSections || []).join('\n\n').trim();
    if (!postReview) {
      postReview =
        decision.status === 'NO_HIGH_TIER'
          ? 'Debate high tier was not available; returned lower-tier result.'
          : decision.status === 'QUOTA_EXHAUSTED'
            ? 'Execution stopped at round boundary because free-tier quota was exhausted.'
          : 'No post-review details available.';
    }

    decision.costEstimateUsd = estimateCostUsd(decision.callCounts);
    decision.freePromptUsage.used = countFreeCalls(decision.callCounts);
    decision.freePromptUsage.nearLimit =
      decision.freePromptUsage.used >=
      Math.floor(decision.freePromptUsage.dailyLimit * 0.8);
    decision.timingMs.total = Date.now() - started;
    decision.cliCapabilities = getCliCapabilitiesSnapshot();

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
      resumeCheckpoint,
      specHistory,
    };
  } catch (err) {
    if (err instanceof PipelineStoppedError) {
      const message = err.message || 'Stopped by caller.';
      decision.status = 'STOPPED';
      decision.convergenceReason = 'STOPPED';
      decision.notes.push(message);
      decision.costEstimateUsd = estimateCostUsd(decision.callCounts);
      decision.freePromptUsage.used = countFreeCalls(decision.callCounts);
      decision.freePromptUsage.nearLimit =
        decision.freePromptUsage.used >=
        Math.floor(decision.freePromptUsage.dailyLimit * 0.8);
      decision.timingMs.total = Date.now() - started;
      decision.cliCapabilities = getCliCapabilitiesSnapshot();
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
        status: 'STOPPED',
        exitCode: EXIT_CODES.stopped,
        spec: finalSpec,
        postImplementationReview: postReview || message,
        decision,
        trace,
        specHistory,
      };
    }
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
    decision.cliCapabilities = getCliCapabilitiesSnapshot();
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
      specHistory,
    };
  }
}
