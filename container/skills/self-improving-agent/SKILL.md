---
name: self-improvement
description: Capture errors, corrections, and recurring lessons into project-local learning logs for continuous improvement in NanoClaw sessions.
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

> NanoClaw Compatible: Converted from legacy ClawHub skill.

# Self-Improving Agent for NanoClaw

Use this skill to maintain project-local learning logs and reduce repeated mistakes.

## Log files

Create and maintain in the current project/group workspace:

- `.learnings/LEARNINGS.md`
- `.learnings/ERRORS.md`
- `.learnings/FEATURE_REQUESTS.md`

## When to log

- Command/tool failures -> `ERRORS.md`
- User corrections -> `LEARNINGS.md` (category: `correction`)
- Better repeatable pattern discovered -> `LEARNINGS.md` (category: `best_practice`)
- Missing requested capability -> `FEATURE_REQUESTS.md`

## Entry format

For each entry include:

- `Date`
- `Context`
- `What happened`
- `Root cause`
- `Actionable fix`
- `Pattern-Key` (stable short key for dedup/search)

## Promotion guidance

Promote high-value recurring lessons into project memory docs:

- `CLAUDE.md`
- `AGENTS.md`
- `.github/copilot-instructions.md` (if present)

## Important constraints

- Do not use legacy platform-specific commands, hooks, or paths.
- Do not rely on inter-session tools like `sessions_*`.
- Keep all artifacts inside the project workspace.
