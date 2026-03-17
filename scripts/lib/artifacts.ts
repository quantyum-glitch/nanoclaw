import fs from 'node:fs';
import path from 'node:path';

import { PipelineDecision, PipelineEvent, PipelineStatus } from './pipeline.js';

export interface ArtifactWriteInput {
  outputDir: string;
  goal: string;
  status: PipelineStatus;
  spec: string;
  postImplementationReview: string;
  decision: PipelineDecision;
  trace: PipelineEvent[];
}

export interface ArtifactWriteResult {
  dir: string;
  specPath: string;
  decisionPath: string;
  tracePath: string;
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) return 'spec';
  return base.slice(0, 64);
}

function timestampKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function statusBanner(status: PipelineStatus): string {
  switch (status) {
    case 'UNREVIEWED':
      return '> [!WARNING]\n> UNREVIEWED: critics were unavailable or timed out. Human review required.';
    case 'FAILED_BLOCKER':
      return '> [!CAUTION]\n> FAILED_BLOCKER: unresolved BLOCKING issues remain. Do not implement without refactor.';
    case 'FAILED_RUBRIC':
      return '> [!CAUTION]\n> FAILED_RUBRIC: required sections are missing after repair attempts.';
    case 'ESCALATION_REQUIRED':
      return '> [!CAUTION]\n> ESCALATION_REQUIRED: unresolved blockers remain and higher-tier review was not run.';
    case 'FAILED_EXPENSIVE':
      return '> [!CAUTION]\n> FAILED_EXPENSIVE: unresolved blockers remain after expensive tier.';
    case 'NO_HIGH_TIER':
      return '> [!NOTE]\n> NO_HIGH_TIER: debate high tier unavailable; result was produced from lower tiers.';
    case 'DEGRADED_LOW':
      return '> [!WARNING]\n> DEGRADED_LOW: low-tier critics were partially unavailable; review confidence is reduced.';
    case 'QUOTA_EXHAUSTED':
      return '> [!WARNING]\n> QUOTA_EXHAUSTED: free-tier prompt budget reached before starting the next round.';
    case 'STOPPED':
      return '> [!WARNING]\n> STOPPED: run was stopped by caller before completion.';
    case 'ERROR':
      return '> [!WARNING]\n> ERROR: pipeline failed. Check decision.json for details.';
    case 'REVIEWED_WITH_MINORS':
      return '> [!TIP]\n> REVIEWED_WITH_MINORS: no blocking issues, but minor findings remain.';
    case 'REVIEWED':
    default:
      return '> [!TIP]\n> REVIEWED: no unresolved blocking issues were detected in the configured flow.';
  }
}

function renderSpecMarkdown(input: ArtifactWriteInput): string {
  const chunks: string[] = [];
  chunks.push(`# Spec: ${input.goal}`);
  chunks.push('');
  chunks.push(statusBanner(input.status));
  chunks.push('');
  chunks.push(input.spec.trim() || '_No spec content generated._');
  chunks.push('');
  if (input.postImplementationReview.trim()) {
    chunks.push('## Post-Implementation Review');
    chunks.push('');
    chunks.push(input.postImplementationReview.trim());
    chunks.push('');
  }
  chunks.push('## Metadata');
  chunks.push('');
  chunks.push(`- Status: \`${input.status}\``);
  chunks.push(
    `- Repeat rounds used: \`${input.decision.repeatRoundsUsed}/${input.decision.repeatRequested}\``,
  );
  chunks.push(`- Tiers used: \`${input.decision.tiersUsed.join(', ') || 'none'}\``);
  chunks.push(`- Cost estimate: \`$${input.decision.costEstimateUsd.toFixed(4)}\``);
  chunks.push(
    `- Free-tier usage: \`${input.decision.freePromptUsage.used}/${input.decision.freePromptUsage.dailyLimit}\``,
  );
  chunks.push(`- Convergence reason: \`${input.decision.convergenceReason}\``);
  if (input.decision.unresolvedBlocking.length > 0) {
    chunks.push(`- Unresolved blocking issues: \`${input.decision.unresolvedBlocking.length}\``);
  }
  return chunks.join('\n');
}

export function writeArtifacts(input: ArtifactWriteInput): ArtifactWriteResult {
  const now = new Date();
  const runDir = path.join(
    input.outputDir,
    `${timestampKey(now)}-${slugify(input.goal)}`,
  );
  fs.mkdirSync(runDir, { recursive: true });

  const specPath = path.join(runDir, 'spec.md');
  const decisionPath = path.join(runDir, 'decision.json');
  const tracePath = path.join(runDir, 'trace.jsonl');

  fs.writeFileSync(specPath, renderSpecMarkdown(input), 'utf-8');
  fs.writeFileSync(decisionPath, JSON.stringify(input.decision, null, 2), 'utf-8');
  const traceLines = input.trace.map((event) => JSON.stringify(event)).join('\n');
  fs.writeFileSync(tracePath, traceLines ? `${traceLines}\n` : '', 'utf-8');

  return {
    dir: runDir,
    specPath,
    decisionPath,
    tracePath,
  };
}
