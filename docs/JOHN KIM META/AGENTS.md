# Agentic Engineering Operating Manual (JK-Aligned)

"Context is best served fresh and condensed."

## Scope and Guardrails
- Canonical context file: `projectcontext.md` at repo root.
- Canonical docs index: `docs/DOCUMENTATION_INDEX.md`.
- Canonical late-adoption bootstrap guide: `docs/PROJECTCONTEXT_BOOTSTRAP.md`.
- `AGENTS.md` is protected and must not be modified unless the user explicitly asks in the active session.

## Pillar 1: Context Engineering

### Session Start Rules
1. Start in repo root.
2. Read `projectcontext.md` first.
3. Consult `docs/DOCUMENTATION_INDEX.md` before loading deep docs.
4. Load only the minimum files needed for the task.

### Second Brain Policy (`projectcontext.md`)
`projectcontext.md` is durable working memory, not scratch notes.

Keep these sections current:
- System architecture and active runtime topology
- Current priorities and open risks
- Decisions and the why behind them
- Validation commands and environment caveats
- Friction ledger entries (see Pillar 3)

Update rules:
- Update after every significant task in the same session.
- Prune stale details; keep it compact and retrieval-oriented.
- Keep pointers to deeper docs instead of copying long content.

### Indexing Policy
- `projectcontext.md` should stay compact and point to indexed docs.
- Domain pointers should resolve through `docs/DOCUMENTATION_INDEX.md` first.
- When a new doc is added/renamed, update the docs index in the same change.

### Planning Discipline (Argue Phase)
Before implementation:
1. Enter plan mode explicitly.
2. Challenge first-pass approach from multiple angles.
3. Check alignment with current architecture and constraints in `projectcontext.md`.
4. Interrupt and correct drift early.

### Late Adoption Bootstrapping
If `projectcontext.md` is missing, stale, or newly introduced in an existing project, follow:
- `docs/PROJECTCONTEXT_BOOTSTRAP.md`

## Pillar 2: Agentic Validation

### Atomic Validation Loop
```text
REPEAT
  1) Make one small change
  2) Validate immediately
  3) If failing: diagnose -> fix -> re-run
  4) Continue until green
```

Rules:
- Never assume correctness without running validation.
- Do not offload simple fixable build/test failures to the user.
- Keep validation tightly scoped to the changed surface, then run broader checks before handoff.

### Multi-Channel Validation Playbooks
Use one or more channels depending on task type:
- Build/type/tests: compile, lint, unit/integration checks
- Runtime smoke: start relevant service and verify boot path
- Browser/UI: scripted navigation, screenshots, interaction checks
- Logs/telemetry: inspect structured logs for expected behavior
- Traces/perf: gather traces when latency/jank/perf is in scope

Validation is a creative engineering task, not just "run build once".

### Spiral Rule (Context Reset)
If three fix attempts fail on the same issue:
1. Stop.
2. Record failed attempts, observations, and hypotheses in `projectcontext.md`.
3. Reset context/session.
4. Reload `projectcontext.md` and re-plan.

### Required Handoff Contract: Validation Evidence
For every major task handoff, include:
```md
## Validation Evidence
- Checks Run:
- Observability Channels Used: (tests/build, browser/screenshots, logs, traces, runtime)
- Failures Found + Fixes:
- Residual Risk:
```

## Pillar 3: Agentic Tooling (Friction Removal)

### Friction Removal Loop
Every blocker is a tooling opportunity.

When friction appears:
1. Log it in `projectcontext.md` under `Friction Ledger`.
2. Classify it as one of:
   - `Tool gap`
   - `Workflow gap`
   - `Codebase gap`
3. Define durable removal path:
   - CLI tool
   - Skill
   - Hook
   - Repo change
4. Prefer permanent fix over repeated manual workaround.

### Required Template: Friction Ledger Entry
```md
### Friction Ledger Entry
- Date:
- Task:
- Blocker:
- Classification: Tool gap | Workflow gap | Codebase gap
- Impact:
- Durable Fix Path: CLI | Skill | Hook | Repo change
- Owner:
- Status:
```

### Skills Workflow (Preserved)
- Build skills from workflows done once manually.
- Ask the agent to generate/update skills; avoid manual authoring when possible.
- Keep skills composable and scoped.

### Hooks Policy (Mechanical Enforcement)
Prefer mechanical controls over instruction-only rules.

Required hook intent:
- Pre-hooks: block dangerous commands/paths, guard protected files
- Post-hooks: run formatting/cleanup/normalization after tool use
- Security hooks: reject destructive or out-of-policy operations by default

## Pillar 4: Agentic Codebases

### Codebase Optimization for Agents
Continuously reduce agent-hostile patterns:
- Remove dead code and obsolete pathways
- Eliminate competing patterns for same responsibility
- Keep file/folder conventions consistent
- Maintain agent-readable logs and docs
- Encode domain rules near the code they govern

Operating rule:
- If domain knowledge is not present in the repo context surface, it is effectively absent for agents.

## Pillar 5: Compound Engineering

### Compounding Rule
Treat every useful improvement as shared infrastructure.

Commit and share:
- New/updated skills
- Hook policies
- Validation loops/playbooks
- Tooling that removes recurring friction
- Context/index improvements

The goal is cumulative capability across sessions and teammates, not one-off local optimization.

### Parallel Instances Policy
Use parallel instances for independent tasks only.

Rules:
- Split work when tasks are independent and context-heavy.
- Use git worktrees for concurrent code edits in the same repo.
- Assign session ownership and names (for example: `feat-web-auth`, `bug-db-timezone`).
- Prevent collisions: one session owns one branch/worktree and one objective.

## Output and Context Update Policy

### Required at Major Task Completion
1. Update `projectcontext.md` in the same session.
2. Include `Validation Evidence` section in handoff output.
3. If no context update was made, explicitly state why.

### Optional Footer for Traceability
```md
[what was iterated]
[how projectcontext.md was updated or why not]
```

## Quick Reference
1. Context first: read `projectcontext.md`, then load only necessary docs via index.
2. Plan and argue before coding.
3. Validate in tight loops with multiple observability channels.
4. Apply spiral reset after three failed attempts.
5. Convert friction into durable tooling.
6. Enforce safety/mechanics with hooks.
7. Keep codebase patterns clean and agent-readable.
8. Compound improvements into shared repo assets.
9. Use worktrees and ownership rules for parallel execution.
