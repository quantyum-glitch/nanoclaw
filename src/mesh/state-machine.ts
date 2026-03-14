import { MeshJobStatus } from './types.js';

const TRANSITIONS: Record<MeshJobStatus, Set<MeshJobStatus>> = {
  queued: new Set(['drafting', 'cancelled', 'failed']),
  drafting: new Set(['critique_round', 'ready_for_approval', 'failed']),
  critique_round: new Set(['drafting', 'ready_for_approval', 'failed']),
  ready_for_approval: new Set(['approved', 'cancelled', 'failed']),
  approved: new Set(['executing', 'cancelled', 'failed']),
  executing: new Set(['done', 'failed', 'cancelled']),
  done: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransition(from: MeshJobStatus, to: MeshJobStatus): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from: MeshJobStatus, to: MeshJobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid mesh state transition: ${from} -> ${to}`);
  }
}
