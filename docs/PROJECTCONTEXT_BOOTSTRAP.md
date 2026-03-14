# Project Context Bootstrap Guide (Late Adoption)

Use this guide when `projectcontext.md` is added late to an existing repo, or when current context is too stale to trust.

## Objective
Create a decision-useful `projectcontext.md` from existing repo evidence with minimal guessing.

## Defaults
- Evidence window: recent 20-30 commits (default)
- Evidence sources:
  1. Git commit history (messages + changed files)
  2. Current key docs under `docs/`
  3. Current code/config entrypoints
- Conflict rule: when evidence conflicts, prefer newer commit-backed evidence over older narrative docs.

## Bootstrap Algorithm
1. **Scan recent history**
   - Run: `git log --name-only --pretty=format:"--- %h %ad %s" --date=short --max-count=30`
   - Identify active subsystems, recent priorities, and recurring failure areas.
2. **Extract decision signals**
   - From commit messages, capture intent and tradeoff language.
   - From touched files, infer system boundaries and integration points.
3. **Read high-value docs**
   - Use `docs/DOCUMENTATION_INDEX.md` to choose only relevant docs.
   - Capture architecture, requirements, security, runtime, and operational constraints.
4. **Cross-check against current tree**
   - Verify that referenced services/scripts/paths still exist.
   - Drop stale claims that no longer match the current repo state.
5. **Draft initial `projectcontext.md` sections**
   - Architecture overview
   - Active systems and environments
   - Key decisions and why
   - Validation commands and handoff checks
   - Risks and known failure modes
   - Current priorities
   - Friction ledger (seed if gaps already visible)
6. **Apply conflict policy**
   - Prefer newest commit-backed truth.
   - Keep older alternatives only as historical notes if still relevant.
7. **Finalize with retrieval links**
   - Add links/pointers to canonical docs via `docs/DOCUMENTATION_INDEX.md`.
   - Keep summaries compact; avoid duplicating full doc bodies.

## Late Bootstrap Intake (Required Template)

```md
## Late Bootstrap Intake
- Evidence window used: last <N> commits (default 20-30)
- Commit range/date:
- Primary subsystems detected:
- Active runtime surfaces:
- Key decisions extracted (with why):
- Validation commands confirmed:
- Risks/open questions:
- Stale or conflicting narratives found:
- Conflict resolution applied:
- Canonical docs linked from index:
```

## Done Criteria
Bootstrap is complete when:
- `projectcontext.md` has all required sections.
- Entries are grounded in recent commit/doc/code evidence.
- Conflicts were resolved with explicit rule application.
- Deep references point to indexed docs, not ad-hoc file hunts.

## Maintenance Rule
After bootstrap, treat `projectcontext.md` as living memory:
- Update after significant tasks.
- Prune stale entries.
- Keep docs index links fresh when docs are added/renamed.
