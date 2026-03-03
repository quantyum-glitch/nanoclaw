---
name: add-posthog
description: Add PostHog MCP integration for analytics/event trend workflows.
---

# Add PostHog

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-posthog
```

## What It Changes

- Adds `POSTHOG_API_KEY` and `POSTHOG_HOST` secret passthrough in `src/container-runner.ts`.
- Adds optional PostHog MCP wiring in `container/agent-runner/src/index.ts`.
- Enables `mcp__posthog__*` tools when API key is configured.
