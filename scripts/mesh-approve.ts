#!/usr/bin/env tsx
import { logger } from '../src/logger.js';
import { assertTransition } from '../src/mesh/state-machine.js';
import {
  appendEvent,
  connectRedis,
  getJob,
  meshApprovalKey,
  nowIso,
  saveJob,
} from '../src/mesh/store.js';
import { MeshJobStatus } from '../src/mesh/types.js';

async function main(): Promise<void> {
  const jobId = process.argv[2];
  const decision = (process.argv[3] || '').toLowerCase();
  const reason = process.argv.slice(4).join(' ') || 'manual decision';

  if (!jobId || !['approve', 'deny'].includes(decision)) {
    console.error('Usage: npm run mesh:approve -- <jobId> <approve|deny> [reason]');
    process.exit(1);
  }

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const client = await connectRedis(redisUrl);
  const workerId = `approval-${process.pid}`;

  try {
    const job = await getJob(client, jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (job.status !== 'ready_for_approval') {
      throw new Error(`Job ${jobId} is in status ${job.status}, expected ready_for_approval`);
    }

    const nextStatus: MeshJobStatus = decision === 'approve' ? 'approved' : 'cancelled';
    assertTransition(job.status, nextStatus);
    job.status = nextStatus;
    job.updatedAt = nowIso();
    await saveJob(client, job);

    await client.set(
      meshApprovalKey(jobId),
      JSON.stringify({
        state: nextStatus,
        jobId,
        reason,
        decidedAt: nowIso(),
      }),
      { EX: 900 },
    );

    await appendEvent(client, {
      eventType: 'status',
      jobId,
      status: nextStatus,
      message: `${decision.toUpperCase()}: ${reason}`,
      timestamp: nowIso(),
      workerId,
      origin: 'mesh-approve',
    });

    logger.info({ jobId, nextStatus }, 'Mesh approval recorded');
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  logger.error({ err }, 'mesh-approve failed');
  process.exit(1);
});

