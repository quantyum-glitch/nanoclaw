#!/usr/bin/env tsx
import { logger } from '../src/logger.js';
import { writeSpecArtifacts } from '../src/mesh/artifacts.js';
import { runDebate } from '../src/mesh/providers.js';
import { assertTransition } from '../src/mesh/state-machine.js';
import {
  MESH_JOBS_STREAM,
  ackEntry,
  acquireLock,
  appendEvent,
  connectRedis,
  ensureConsumerGroup,
  getJob,
  makeWorkerId,
  meshApprovalKey,
  meshLockKey,
  nowIso,
  readGroupEntries,
  releaseLock,
  saveJob,
} from '../src/mesh/store.js';
import { MeshJob, MeshJobStatus } from '../src/mesh/types.js';

const GROUP = 'mesh-orchestrator';
const ORIGIN = 'mesh-orchestrator';

async function setStatus(
  client: Awaited<ReturnType<typeof connectRedis>>,
  job: MeshJob,
  next: MeshJobStatus,
  message: string,
  workerId: string,
): Promise<void> {
  assertTransition(job.status, next);
  job.status = next;
  job.updatedAt = nowIso();
  await saveJob(client, job);
  await appendEvent(client, {
    eventType: 'status',
    jobId: job.jobId,
    status: next,
    message,
    timestamp: nowIso(),
    workerId,
    origin: ORIGIN,
  });
}

async function failJob(
  client: Awaited<ReturnType<typeof connectRedis>>,
  job: MeshJob,
  err: unknown,
  workerId: string,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    if (job.status !== 'failed' && job.status !== 'done' && job.status !== 'cancelled') {
      assertTransition(job.status, 'failed');
      job.status = 'failed';
    }
  } catch {
    job.status = 'failed';
  }
  job.updatedAt = nowIso();
  job.error = message;
  await saveJob(client, job);
  await appendEvent(client, {
    eventType: 'error',
    jobId: job.jobId,
    status: 'failed',
    message,
    timestamp: nowIso(),
    workerId,
    origin: ORIGIN,
  });
}

async function processJob(
  client: Awaited<ReturnType<typeof connectRedis>>,
  job: MeshJob,
  workerId: string,
): Promise<void> {
  if (job.status !== 'queued') {
    await appendEvent(client, {
      eventType: 'log',
      jobId: job.jobId,
      status: job.status,
      message: `Skipping job in status ${job.status}`,
      timestamp: nowIso(),
      workerId,
      origin: ORIGIN,
    });
    return;
  }

  await setStatus(client, job, 'drafting', 'Generating draft spec', workerId);
  const { finalSpec, decision } = await runDebate(job);
  job.round = decision.round;
  job.updatedAt = nowIso();
  await saveJob(client, job);

  const paths = writeSpecArtifacts(job, finalSpec, decision);
  await appendEvent(client, {
    eventType: 'log',
    jobId: job.jobId,
    status: 'drafting',
    message: `Artifacts written: ${paths.specPath}`,
    timestamp: nowIso(),
    workerId,
    origin: ORIGIN,
  });

  if (job.requiresApproval) {
    await setStatus(
      client,
      job,
      'ready_for_approval',
      'Spec ready for approval',
      workerId,
    );
    await client.set(
      meshApprovalKey(job.jobId),
      JSON.stringify({
        state: 'pending',
        jobId: job.jobId,
        createdAt: nowIso(),
      }),
      { EX: 900 },
    );
  } else {
    await setStatus(client, job, 'approved', 'Auto-approved by policy', workerId);
  }
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const consumer = makeWorkerId('orchestrator');
  const client = await connectRedis(redisUrl);
  await ensureConsumerGroup(client, MESH_JOBS_STREAM, GROUP);

  logger.info({ redisUrl, consumer }, 'Mesh orchestrator started');
  while (true) {
    const entries = await readGroupEntries(
      client,
      MESH_JOBS_STREAM,
      GROUP,
      consumer,
      1,
      5000,
    );
    if (entries.length === 0) continue;

    for (const entry of entries) {
      const jobId = entry.message.jobId || '';
      if (!jobId) {
        await ackEntry(client, MESH_JOBS_STREAM, GROUP, entry.id);
        continue;
      }

      const lockKey = meshLockKey(jobId);
      const lockOwner = `${consumer}:${entry.id}`;
      const locked = await acquireLock(client, lockKey, lockOwner, 600);
      if (!locked) {
        await ackEntry(client, MESH_JOBS_STREAM, GROUP, entry.id);
        continue;
      }

      try {
        const job = await getJob(client, jobId);
        if (!job) {
          throw new Error(`Missing job payload for ${jobId}`);
        }
        await processJob(client, job, consumer);
      } catch (err) {
        const job = await getJob(client, jobId);
        if (job) {
          await failJob(client, job, err, consumer);
        } else {
          logger.error({ err, jobId }, 'Mesh orchestrator failed before job load');
        }
      } finally {
        await ackEntry(client, MESH_JOBS_STREAM, GROUP, entry.id);
        await releaseLock(client, lockKey);
      }
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'mesh-orchestrator crashed');
  process.exit(1);
});

