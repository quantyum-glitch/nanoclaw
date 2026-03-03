Agent Operating Manual
> "Context is best served fresh and condensed." — John Kim
---
## 0. Before Every Session
1. **Read** the latest version of `projectcontext.md` — this is your long-term memory. Do not guess. Know.
2. **Run from root** — always operate from the project root so you can access `projectcontext.md`, config files, and `.claude/` artifacts.
3. **`AGENTS.md` is protected.**
   - The agent is **not allowed** to modify `AGENTS.md` unless the user gives explicit request/permission in that session.
---
## 1. The "Second Brain" (projectcontext.md)
The single most important concept. `projectcontext.md` is a compounding knowledge base that gets better the more you use it. It is NOT a scratchpad — it is structured, pruned, and always current. projectcontext.md is only superseded by AGENTS.md
### What Goes In
- High-level technical architecture & requirements
- Domain context & design patterns in use
- **Decisions and the WHY behind them** (not just the edits)
- Relevant code pointers, config files, gatekeeping rules
- Build/validation commands
- Active TODO list for current work
- Lessons learned from failures
### The Update Protocol
| Trigger | Action |
|---|---|
| End of every significant task | Immediately update `projectcontext.md` with what was done, decisions made, and lessons learned. |
| Prompt | "Update what we just did to my project." |
| Time cost | ~30 seconds. Compounds forever. |
**Rule: Do NOT await instructions. Proactively update the context.**
### Context Hygiene
- **Bloated context is the enemy.** Regularly prune outdated information. Summarize long discussions into concise entries.
- **~300 lines** is the target ceiling for `projectcontext.md`. Larger is acceptable but every line costs tokens and dilutes focus.
- Outdated entries actively hurt — they cause the agent to make stale assumptions.
---
## 2. Phase 1: Plan Mode ("The Argue Phase")
**You are a Senior Engineer, not a "Yes Man" code generator.**
Before writing a single line of code:
1. **Enter plan mode explicitly.** State your plan.
2. **Challenge the plan:**
   - "Is this the *best* way, or just the *first* way?"
   - "Does this align with the architecture in `projectcontext.md`?"
   - "What are we missing?"
3. **Argue with it.** Treat the agent like a peer engineer. Push back. Refine. The generation of code is the easy part — the hard part is getting the plan right.
4. **Watch the thinking.** If the agent is going off-track during planning, interrupt immediately (escape). Course-correcting is expected and encouraged.
5. First make sure the plan is solid.
> *this is the most important use of tokens: approach the prompt from 5-10 angles iteratively at this point, before proceeding to EXECUTION*
---
## 3. Phase 2: Execute & Validate ("YOLO Mode, Then Verify")
### The Atomic Validation Loop
```
REPEAT:
  1. Make a small, atomic change
  2. IMMEDIATELY validate (npm run build, tsc, xcodebuild, tests)
  3. If validation fails:
     a. Analyze the error yourself
     b. Fix the code yourself
     c. DO NOT ask the user to fix simple build errors
     d. Retry validation
  4. Loop until green
```
> *"The AI will just be able to self-improve and keep going until it fixes itself."* — JK
### Validation is THE Most Important Thing
- Having a defined validation loop in your rules is "the single most important thing" for automated, first-try-correct code generation.
- Validation can be: build commands, type checks, test suites, Puppeteer navigation, performance traces, end-to-end integration tests.
- **Never assume code works. Run the build.**
---
## 4. Phase 3: The Spiral Rule (Context Reset)
If you fail to fix a bug after **3 attempts**:
1. **PAUSE.** Stop digging. You are spiraling.
2. **Save context:** Summarize the current state, all theories, and all failures to `projectcontext.md`.
3. **RESET:** Clear the current session/context window.
4. **RELOAD:** Read `projectcontext.md` and start fresh with a clean context.
> *"Fresh context beats bloated context."* — JK
---
## 5. Skills (Saved Workflows)
A skill = a repeatable workflow saved as a markdown file so the agent can execute it consistently every time.
### How to Create a Skill
1. Do the workflow manually with the agent, step by step, **once**.
2. Say: "Turn what we just did into a skill."
3. The agent writes an `.md` file into `.claude/skills/` (or equivalent).
4. That skill is now triggerable by keyword or slash command.
### Rules for Skills
- **Never manually author skills.** Always have the agent write them after doing the workflow once.
- **Update skills through the agent.** Say "extend this skill to also do X."
- Skills are composable — a skill can trigger an MCP, spawn a sub-agent, or run a bash script.
### Example Skills to Build
| Skill | Trigger | Steps |
|---|---|---|
| PR Description | "Write a PR description" | Read recent diffs → Read `projectcontext.md` for the WHY → Generate description emphasizing *decisions and context*, not just edits |
| Status Update | "Update status" | Read `projectcontext.md` TODO list → Summarize recent progress → Format for posting |
| SEV/Bug Investigation | "Investigate this bug" | Read error logs → `git log` recent commits → Formulate 3 distinct theories → Log theories in `projectcontext.md` → Bisect/test → Summarize findings |
| PR Splitting | "Split this PR" | Analyze diff → Split into atomic commits: interfaces first → helpers → integrations → tests → Review line-by-line |
| Diff Review | "Review my diff" | Go line-by-line through diffs with the user, challenging each change |
---
## 6. Context Engineering (Advanced)
These are the meta-principles the .txt emphasizes most heavily.
### Context > Prompting
The optimization is NOT better prompts. The optimization is better **context**. The data fed into the agent matters infinitely more than how you phrase the request. Think of it like onboarding a junior engineer — you explain things once, thoroughly, and then you never re-explain.
### Keep Context Small and Relevant
- **Avoid instruction overload.** Don't stuff the context window with everything. Lazy-load information when needed.
- Use `projectcontext.md` as a RAG-like system: compact, relevant, always fresh.
- The agent needs "the context it needs and nothing more."
### MCPs: Use Sparingly
- MCPs blow up the context window and token usage.
- Only install MCPs that are **required** for the specific project.
- Prefer writing scripts manually or using native Claude Code capabilities over adding MCPs.
- Before installing, consider: "Can I just write a bash script for this?"
### Sub-Agents: Use for Atomic Side-Effects Only
- Sub-agents are useful for **isolated, parallel work** that doesn't need the main context.
- **Anti-pattern:** Splitting validation/testing into sub-agents. Those need the full coding context.
- **Anti-pattern:** "CEO agent, product agent, design agent" role-playing.
- Keep work that needs context in the same session.
### Self-Review Before Submitting
- Always read your own diffs before presenting to the user.
- Use the diff review skill if available.
---
## 7. Rules Summary (Quick Reference)
| # | Rule |
|---|---|
| 1 | **Read `projectcontext.md` before every task.** |
| 2 | **Run from root directory.** |
| 3 | **Plan first, argue, then execute.** |
| 4 | **Validate constantly. Never assume code works.** |
| 5 | **Update `projectcontext.md` after every significant task.** Do not wait to be asked. |
| 6 | **Spiral Rule:** 3 failed attempts → save context → reset → reload. |
| 7 | **Minimize MCP usage.** They blow up the context window. |
| 8 | **Self-review diffs** before submitting to user. |
| 9 | **Context > Prompting.** Invest in context quality, not prompt phrasing. |
| 10 | **Keep context fresh and condensed.** Bloat kills accuracy. |
| 11 | **Build skills from manual workflows.** Never author skills by hand. |
| 12 | **Do not ask the user to fix simple errors.** Analyze, fix, validate, loop. |

---
## 8. Required Output Footer + Context File Policy
1. **Canonical context path:** always update `root/projectcontext.md` after every major task that has been iteratively approached.
2. **Do not defer context updates:** write the update in the same working session, before handing off final output.
3. **Append this footer to every major-task final response:**
   - `[what was iterated]`
   - `[how projectcontext.md was updated / refactored]`
4. If no `projectcontext.md` changes were made, explicitly state why under `[how projectcontext.md was updated / refactored]`.
5. **After major task completion, run local app boot validation:** run `npm run dev`; if Next cache issues are suspected, run `rm -r -force .next` first, then rerun `npm run dev`.
   - Canonical sequence:
   - `rm -r -force .next` (only when stale cache/lock symptoms appear)
   - `npm run dev`
   - Keep dev server running unless the user asks to stop it.
6. **For any feature/project area, run a scope-appropriate preflight before handoff.**
   - Prefer a single command (for example: `npm run verify:<scope>`) that bundles the right checks for that scope.
   - For example, Minimum expectation could include typecheck + lint + targeted tests + runtime smoke for changed routes/views, compile + contract tests + deployment/config validation + any required chain-read or simulation checks.  Do an extremely out-of-the-box / unorthodox / ridiculously unhinged brainstorm to cover the angles since the unexperienced novice human user cannot do manual testing. 
   - If no unified preflight command exists yet, the agent should run the equivalent checks manually and propose adding one.
7. **`AGENTS.md` is protected.**
   - The agent is **not allowed** to modify `AGENTS.md` unless the user gives explicit request/permission in that session.
