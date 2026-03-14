export type MeshJobStatus =
  | 'queued'
  | 'drafting'
  | 'critique_round'
  | 'ready_for_approval'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface MeshJob {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  source: string;
  repo: string;
  goal: string;
  constraints: string[];
  maxRounds: number;
  round: number;
  status: MeshJobStatus;
  requiresApproval: boolean;
  error?: string;
}

export interface MeshDecision {
  summary: string;
  score: number;
  passed: boolean;
  round: number;
  draft: string;
  geminiCritique?: string;
  kimiCritique?: string;
  rubric: {
    hasSummary: boolean;
    hasArchitecture: boolean;
    hasTests: boolean;
    hasRisks: boolean;
  };
}

export interface MeshEvent {
  eventType: 'status' | 'log' | 'error';
  jobId: string;
  status?: MeshJobStatus;
  message: string;
  timestamp: string;
  workerId: string;
  origin: string;
}

