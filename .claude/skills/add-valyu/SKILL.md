---
name: add-valyu
description: Add Valyu MCP integration to NanoClaw for web search/research, plus Anthropic-compatible endpoint env passthrough for low-cost gateway routing.
---

# Add Valyu

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-valyu
```

## What It Changes

- Adds `VALYU_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` env support in `src/container-runner.ts`.
- Restores `.env` shadow mount protection for main-group project mount.
- Adds optional Valyu MCP server wiring in `container/agent-runner/src/index.ts`.
- Enables Valyu tools when key is configured (`mcp__valyu__*`).

## Required Environment

Set in `.env`:

```bash
VALYU_API_KEY=...
ANTHROPIC_BASE_URL=...
ANTHROPIC_AUTH_TOKEN=...
```

## Validate

```bash
npm run typecheck
npm test
```
