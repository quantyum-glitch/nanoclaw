---
name: add-context7
description: Add Context7 MCP integration for live version-specific documentation lookup.
---

# Add Context7

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-context7
```

## What It Changes

- Adds `CONTEXT7_API_KEY` passthrough to the container runner.
- Adds optional Context7 MCP wiring in `container/agent-runner/src/index.ts`.
- Enables `mcp__context7__*` tools when API key is configured.
