import fs from 'node:fs';
import path from 'node:path';

import { PipelineDecision, PipelineStatus } from './pipeline.js';

export interface ArtifactWriteInput {
  outputDir: string;
  goal: string;
  status: PipelineStatus;
  spec: string;
  postImplementationReview: string;
  decision: PipelineDecision;
}

export interface ArtifactWriteResult {
  dir: string;
  specPath: string;
  decisionPath: string;
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
    case 'ESCALATION_REQUIRED':
      return '> [!CAUTION]\n> ESCALATION_REQUIRED: unresolved blockers remain and higher-tier review was not run.';
    case 'FAILED_EXPENSIVE':
      return '> [!CAUTION]\n> FAILED_EXPENSIVE: unresolved blockers remain after expensive tier.';
    case 'ERROR':
      return '> [!WARNING]\n> ERROR: pipeline failed. Check decision.json for details.';
    case 'DRAFT_ONLY':
      return '> [!NOTE]\n> DRAFT_ONLY: no critic pass was executed.';
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
  chunks.push('## Post-Implementation Review');
  chunks.push('');
  chunks.push(input.postImplementationReview.trim() || '_No post-review content._');
  chunks.push('');
  chunks.push('## Metadata');
  chunks.push('');
  chunks.push(`- Status: \`${input.status}\``);
  chunks.push(`- Rounds used: \`${input.decision.roundsUsed}\``);
  chunks.push(`- Tiers used: \`${input.decision.tiersUsed.join(', ') || 'none'}\``);
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

  fs.writeFileSync(specPath, renderSpecMarkdown(input), 'utf-8');
  fs.writeFileSync(decisionPath, JSON.stringify(input.decision, null, 2), 'utf-8');

  return {
    dir: runDir,
    specPath,
    decisionPath,
  };
}
