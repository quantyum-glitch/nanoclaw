#!/usr/bin/env tsx
import { spawn } from 'child_process';
import path from 'path';

import { logger } from '../src/logger.js';
import { resolveArtifactRoot, writeExecutionArtifacts } from '../src/mesh/artifacts.js';
import { assertTransition } from '../src/mesh/state-machine.js';
import {
  MESH_EVENTS_STREAM,
  ackEntry,
  acquireLock,
  appendEvent,
  connectRedis,
  ensureConsumerGroup,
  getJob,
  makeWorkerId,
  meshLockKey,
  nowIso,
  readGroupEntries,
  releaseLock,
  saveJob,
} from '../src/mesh/store.js';

const GROUP = 'mesh-executor';
const ORIGIN = 'mesh-executor';

function interpolate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${key}}`, value);
  }
  return out;
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Executor command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const consumer = makeWorkerId('executor');
  const client = await connectRedis(redisUrl);
  await ensureConsumerGroup(client, MESH_EVENTS_STREAM, GROUP);

  logger.info({ redisUrl, consumer }, 'Mesh executor started');
  while (true) {
    const entries = await readGroupEntries(
      client,
      MESH_EVENTS_STREAM,
      GROUP,
      consumer,
      1,
      5000,
    );
    if (entries.length === 0) continue;

    for (const entry of entries) {
      const eventType = entry.message.eventType || '';
      const status = entry.message.status || '';
      const jobId = entry.message.jobId || '';
      if (eventType !== 'status' || status !== 'approved' || !jobId) {
        await ackEntry(client, MESH_EVENTS_STREAM, GROUP, entry.id);
        continue;
      }

      const lockKey = meshLockKey(jobId);
      const lockOwner = `${consumer}:${entry.id}`;
      const locked = await acquireLock(client, lockKey, lockOwner, 1800);
      if (!locked) {
        await ackEntry(client, MESH_EVENTS_STREAM, GROUP, entry.id);
        continue;
      }

      try {
        const job = await getJob(client, jobId);
        if (!job) {
          throw new Error(`Job not found for approved event: ${jobId}`);
        }
        if (job.status !== 'approved') {
          await appendEvent(client, {
            eventType: 'log',
            jobId,
            status: job.status,
            message: `Skipping approved event because job status is ${job.status}`,
            timestamp: nowIso(),
            workerId: consumer,
            origin: ORIGIN,
          });
          continue;
        }

        assertTransition(job.status, 'executing');
        job.status = 'executing';
        job.updatedAt = nowIso();
        await saveJob(client, job);
        await appendEvent(client, {
          eventType: 'status',
          jobId,
          status: 'executing',
          message: 'Execution started on Dell worker',
          timestamp: nowIso(),
          workerId: consumer,
          origin: ORIGIN,
        });

        const artifactRoot = resolveArtifactRoot();
        const specPath = path.join(artifactRoot, jobId, 'spec.md');
        const decisionPath = path.join(artifactRoot, jobId, 'decision.json');
        const commandTemplate =
          process.env.MESH_EXECUTOR_CMD ||
          'echo "[mesh] TODO: run Codex/VSCode executor for {jobId}"';
        const command = interpolate(commandTemplate, {
          jobId,
          repo: job.repo,
          specPath,
          decisionPath,
        });
        const startedAt = nowIso();
        const execResult = await runCommand(
          command,
          job.repo || process.cwd(),
          parseInt(process.env.MESH_EXECUTOR_TIMEOUT_MS || '1200000', 10),
        );
        const endedAt = nowIso();

        writeExecutionArtifacts(job, {
          command,
          exitCode: execResult.exitCode,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          startedAt,
          endedAt,
        });

        if (execResult.exitCode === 0) {
          assertTransition(job.status, 'done');
          job.status = 'done';
          job.updatedAt = nowIso();
          await saveJob(client, job);
          await appendEvent(client, {
            eventType: 'status',
            jobId,
            status: 'done',
            message: 'Execution completed successfully',
            timestamp: nowIso(),
            workerId: consumer,
            origin: ORIGIN,
          });
        } else {
          assertTransition(job.status, 'failed');
          job.status = 'failed';
          job.updatedAt = nowIso();
          job.error = execResult.stderr || `Executor exited ${execResult.exitCode}`;
          await saveJob(client, job);
          await appendEvent(client, {
            eventType: 'error',
            jobId,
            status: 'failed',
            message: job.error,
            timestamp: nowIso(),
            workerId: consumer,
            origin: ORIGIN,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, jobId }, 'Mesh executor failed');
        const job = await getJob(client, jobId);
        if (job && job.status !== 'done' && job.status !== 'cancelled') {
          try {
            if (job.status !== 'failed') {
              assertTransition(job.status, 'failed');
              job.status = 'failed';
            }
          } catch {
            job.status = 'failed';
          }
          job.updatedAt = nowIso();
          job.error = message;
          await saveJob(client, job);
        }
        await appendEvent(client, {
          eventType: 'error',
          jobId,
          status: 'failed',
          message,
          timestamp: nowIso(),
          workerId: consumer,
          origin: ORIGIN,
        });
      } finally {
        await ackEntry(client, MESH_EVENTS_STREAM, GROUP, entry.id);
        await releaseLock(client, lockKey);
      }
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'mesh-executor crashed');
  process.exit(1);
});

