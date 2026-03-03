---
name: add-supabase
description: Add Supabase MCP integration for schema/docs and database operations.
---

# Add Supabase

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-supabase
```

## What It Changes

- Adds `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` passthrough to container runner.
- Adds optional Supabase remote MCP wiring in `container/agent-runner/src/index.ts`.
- Enables `mcp__supabase__*` tools when both env vars are configured.
