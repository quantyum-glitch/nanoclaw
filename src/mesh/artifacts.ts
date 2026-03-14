import fs from 'fs';
import path from 'path';

import { MeshDecision, MeshJob } from './types.js';

export function resolveArtifactRoot(): string {
  if (process.env.MESH_ARTIFACT_ROOT) {
    return path.resolve(process.env.MESH_ARTIFACT_ROOT);
  }
  return path.resolve(process.cwd(), 'store', 'mesh-specs');
}

export function ensureJobArtifactDir(jobId: string): string {
  const dir = path.join(resolveArtifactRoot(), jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSpecArtifacts(
  job: MeshJob,
  spec: string,
  decision: MeshDecision,
): { jobDir: string; specPath: string; decisionPath: string } {
  const jobDir = ensureJobArtifactDir(job.jobId);
  const specPath = path.join(jobDir, 'spec.md');
  const decisionPath = path.join(jobDir, 'decision.json');

  fs.writeFileSync(specPath, spec, 'utf-8');
  fs.writeFileSync(
    decisionPath,
    JSON.stringify(
      {
        job,
        decision,
      },
      null,
      2,
    ),
    'utf-8',
  );

  return { jobDir, specPath, decisionPath };
}

export function writeExecutionArtifacts(
  job: MeshJob,
  result: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    startedAt: string;
    endedAt: string;
  },
): string {
  const jobDir = ensureJobArtifactDir(job.jobId);
  const executionPath = path.join(jobDir, 'execution_log.json');
  fs.writeFileSync(executionPath, JSON.stringify(result, null, 2), 'utf-8');
  return executionPath;
}
