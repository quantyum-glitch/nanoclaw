import crypto from 'crypto';

import { createClient } from 'redis';

import { MeshEvent, MeshJob } from './types.js';

export const MESH_JOBS_STREAM = 'mesh:jobs';
export const MESH_EVENTS_STREAM = 'mesh:events';
export type MeshRedisClient = ReturnType<typeof createClient>;

export interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

export function meshJobKey(jobId: string): string {
  return `mesh:job:${jobId}`;
}

export function meshLockKey(jobId: string): string {
  return `mesh:lock:${jobId}`;
}

export function meshApprovalKey(jobId: string): string {
  return `mesh:approval:${jobId}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeWorkerId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function connectRedis(redisUrl: string): Promise<MeshRedisClient> {
  const client = createClient({ url: redisUrl });
  await client.connect();
  return client;
}

export async function ensureConsumerGroup(
  client: MeshRedisClient,
  stream: string,
  group: string,
): Promise<void> {
  try {
    await client.xGroupCreate(stream, group, '$', { MKSTREAM: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('BUSYGROUP')) {
      throw err;
    }
  }
}

export async function readGroupEntries(
  client: MeshRedisClient,
  stream: string,
  group: string,
  consumer: string,
  count = 1,
  blockMs = 5000,
): Promise<StreamEntry[]> {
  const response = (await client.xReadGroup(
    group,
    consumer,
    [{ key: stream, id: '>' }],
    { COUNT: count, BLOCK: blockMs },
  )) as Array<{
    name: string;
    messages: Array<{ id: string; message: Record<string, string> }>;
  }> | null;

  if (!response || response.length === 0) {
    return [];
  }

  const entries: StreamEntry[] = [];
  for (const streamResponse of response) {
    for (const msg of streamResponse.messages) {
      entries.push({ id: msg.id, message: msg.message });
    }
  }
  return entries;
}

export async function appendJob(
  client: MeshRedisClient,
  job: MeshJob,
): Promise<void> {
  await client.set(meshJobKey(job.jobId), JSON.stringify(job));
  await client.xAdd(MESH_JOBS_STREAM, '*', {
    jobId: job.jobId,
    payload: JSON.stringify(job),
  });
}

export async function getJob(
  client: MeshRedisClient,
  jobId: string,
): Promise<MeshJob | null> {
  const raw = await client.get(meshJobKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw) as MeshJob;
}

export async function saveJob(
  client: MeshRedisClient,
  job: MeshJob,
): Promise<void> {
  await client.set(meshJobKey(job.jobId), JSON.stringify(job));
}

export async function appendEvent(
  client: MeshRedisClient,
  event: MeshEvent,
): Promise<void> {
  await client.xAdd(MESH_EVENTS_STREAM, '*', {
    eventType: event.eventType,
    jobId: event.jobId,
    status: event.status || '',
    message: event.message,
    timestamp: event.timestamp,
    workerId: event.workerId,
    origin: event.origin,
    payload: JSON.stringify(event),
  });
}

export async function ackEntry(
  client: MeshRedisClient,
  stream: string,
  group: string,
  id: string,
): Promise<void> {
  await client.xAck(stream, group, id);
}

export async function acquireLock(
  client: MeshRedisClient,
  key: string,
  owner: string,
  ttlSec: number,
): Promise<boolean> {
  const result = await client.set(key, owner, { NX: true, EX: ttlSec });
  return result === 'OK';
}

export async function releaseLock(
  client: MeshRedisClient,
  key: string,
): Promise<void> {
  await client.del(key);
}
