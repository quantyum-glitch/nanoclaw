#!/usr/bin/env tsx
import crypto from 'crypto';

import { logger } from '../src/logger.js';
import {
  appendEvent,
  appendJob,
  connectRedis,
  nowIso,
} from '../src/mesh/store.js';
import { MeshEvent, MeshJob } from '../src/mesh/types.js';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const goal = args.goal || '';
  if (!goal) {
    console.error(
      'Usage: npm run mesh:submit -- --goal "your task" [--repo path] [--constraints "a,b,c"] [--max-rounds 3]',
    );
    process.exit(1);
  }

  const jobId = args.jobId || `job_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
  const timestamp = nowIso();
  const constraints = (args.constraints || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const maxRoundsRaw = parseInt(args['max-rounds'] || '3', 10);
  const maxRounds = Number.isFinite(maxRoundsRaw)
    ? Math.min(Math.max(maxRoundsRaw, 1), 5)
    : 3;

  const job: MeshJob = {
    jobId,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: args.source || 'nanoclaw:web:main',
    repo: args.repo || process.cwd(),
    goal,
    constraints,
    maxRounds,
    round: 0,
    status: 'queued',
    requiresApproval: args['requires-approval']
      ? args['requires-approval'] !== 'false'
      : true,
  };

  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const client = await connectRedis(redisUrl);
  const workerId = `submit-${process.pid}`;
  try {
    await appendJob(client, job);
    const queuedEvent: MeshEvent = {
      eventType: 'status',
      jobId,
      status: 'queued',
      message: `Job submitted from ${job.source}`,
      timestamp,
      workerId,
      origin: 'mesh-submit',
    };
    await appendEvent(client, queuedEvent);
  } finally {
    await client.disconnect();
  }

  logger.info({ jobId, redisUrl }, 'Mesh job submitted');
}

main().catch((err) => {
  logger.error({ err }, 'mesh-submit failed');
  process.exit(1);
});
