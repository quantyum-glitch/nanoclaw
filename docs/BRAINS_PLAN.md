# Brains Plan (From 2NanoClaw, Safe Ports Only)

This plan keeps NanoClaw runtime unchanged and adds host-side model orchestration.

## Safe to Port Now

1. `sql.js` SQLite shim (behind flag): done via `NANOCLAW_USE_SQLITE_SHIM=1`.
2. Observability: runtime + MCP + container telemetry logs.
3. Multi-model critique/debate scripts with OpenRouter free models.
4. External coding-agent workflow docs (OpenCode, Cline, Gemini, Aider).

## Intentionally Not Ported

1. Host terminal execution tools from `2NanoClaw/src/tools/terminal.ts`.
2. Host file mutation tools from `2NanoClaw/src/tools/file-ops.ts`.
3. Full runtime replacement with Vercel AI SDK consensus engine.

Reason: these bypass NanoClaw's container-first isolation model.

## Near-Zero-Cost Brain Topology

1. Primary: `openrouter/free` (or another free general model).
2. Critics: 2-4 free models from `npm run llm:list-free`.
3. Synthesizer: stable free model with best consistency in your logs.

## How to Operate

1. Refresh candidate models weekly:
   - `npm run llm:list-free`
2. Update `OPENROUTER_DEBATE_MODELS` in `.env`.
3. Run debate for each high-impact change:
   - `npm run llm:debate -- --prompt "..."`
4. Feed synthesis output to your coding agent (Cline/Gemini/OpenCode/Aider).
5. Accept only if local validation passes.

## Validation Gate

Minimum before merge:

1. `npm run typecheck`
2. Targeted tests for touched files
3. Container runner build when MCP/runner changes:
   - `npm --prefix container/agent-runner run build`

## Cost/Safety Guardrails

1. Keep paid models disabled by default.
2. Set provider-side daily cap/rate limits.
3. Never include secrets in debate prompts.
4. Keep dangerous host-exec integrations out of runtime path.
