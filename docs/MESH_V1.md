# Mesh V1 (U56E Orchestrator + Dell Executor)

This document describes the first runnable implementation of the multi-node mesh pipeline.

## Components

- `scripts/mesh-submit.ts` - submit a new job into Redis stream `mesh:jobs`
- `scripts/mesh-orchestrator.ts` - consume jobs, run debate loop, write spec artifacts
- `scripts/mesh-approve.ts` - manual approve/deny gate
- `scripts/mesh-executor.ts` - consume approved events and run executor command

## Redis Keys

- Stream `mesh:jobs`
- Stream `mesh:events`
- Key `mesh:job:<jobId>`
- Key `mesh:lock:<jobId>`
- Key `mesh:approval:<jobId>`

## Job State Flow

`queued -> drafting -> ready_for_approval -> approved -> executing -> done`

Failure states:

- `failed`
- `cancelled`

## Required Environment

- `REDIS_URL` (default: `redis://127.0.0.1:6379`)
- `OPENROUTER_API_KEY` (or `OPENROUTER_AUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`)

Optional critiques:

- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `KIMI_API_KEY`, `KIMI_MODEL`, `KIMI_BASE_URL`

Executor options:

- `MESH_EXECUTOR_CMD` (default: echo placeholder)
- `MESH_EXECUTOR_TIMEOUT_MS` (default: 1200000)
- `MESH_ARTIFACT_ROOT` (default: `./store/mesh-specs`)

## Basic Runbook

1. Start orchestrator:

```bash
npm run mesh:orchestrator
```

2. Start executor on Dell:

```bash
npm run mesh:executor
```

3. Submit a job:

```bash
npm run mesh:submit -- --goal "implement feature X" --repo "C:/repo/path" --constraints "tests required,no destructive git"
```

4. Approve or deny after spec generation:

```bash
npm run mesh:approve -- <jobId> approve "looks good"
npm run mesh:approve -- <jobId> deny "needs better test plan"
```

5. Inspect artifacts:

- `store/mesh-specs/<jobId>/spec.md`
- `store/mesh-specs/<jobId>/decision.json`
- `store/mesh-specs/<jobId>/execution_log.json`

