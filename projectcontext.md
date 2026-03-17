# Home AI Dev Environment - Architecture & Context

## Documentation Retrieval
- Documentation index: [docs/DOCUMENTATION_INDEX.md](docs/DOCUMENTATION_INDEX.md)
- Rule: Consult the docs index before deep-dive retrieval so the canonical document is loaded first.

## Historical Baseline (Preserved)

### Device Allocation (v9 deployed baseline)
| Device | Role | Storage | Status |
|:---|:---|:---|:---|
| Asus U56E (i5, 8GB) | Headless server | 2TB SSD | Live |
| Dell G5 SE (Ryzen 7, 8GB) | Dev workstation + local AI | 1TB NVMe | Active |
| Chromebook 714 (4GB) | Daily driver | eMMC | Active |
| Firestick | TV/YouTube client | n/a | Active |
| Acer R11 (4GB) | Secondary streaming | eMMC | Active |
| MacBook A1278 (4GB) | Cold spare | 500GB HDD | Drawer |

### U56E Service Baseline
| Service | Port | Status |
|:---|:---|:---|
| SSH | 22 | Active |
| Pi-hole | 80/admin | Active |
| Tailscale | n/a | Active |
| Samba (`family`, `guest-photos`) | 445 | Active |
| NanoClaw (`systemd --user`) | n/a | Active |
| Immich | 2283 | Healthy |
| Redis (for web channel bridge) | 6379 | Active |

### Baseline Notes
- NanoClaw Linux runtime expects Docker for container runtime.
- Web channel was enabled as fallback control path when QR pairing in fork was broken.
- Node 20 installed on U56E.
- Samba was hardened with separate family/guest access model.

## Update - 2026-03-13 (Today)

### NanoClaw Upstream + Runtime
- U56E NanoClaw repo synced to upstream `qwibitai/main` and local runtime patches re-applied.
- Gmail channel import enabled in channel registration.
- NanoClaw service confirmed active after restart.

### Web Channel Access
- Deployed standalone web UI service (`nanoclaw-web`) on U56E port `3010`.
- Added firewall rules for `3010/tcp` from LAN and Tailscale range only.
- Added service directory panel in web UI with LAN + Tailscale URLs.
- Updated web UI theme from bright white to dark green for better day/night readability.

### SSH Login UX (MOTD)
- Added custom MOTD script on U56E:
  - `/etc/update-motd.d/99-homelab-links`
- SSH login now shows:
  - NanoClaw web URL
  - Immich URL
  - Pi-hole URL
  - Tailscale IP and remote URLs
  - Samba UNC paths

### Tailscale Remote Control
- Confirmed U56E Tailscale IPv4: `100.68.120.27`.
- Remote control path is now:
  - `http://100.68.120.27:3010` (NanoClaw web)
  - `ssh jam@100.68.120.27`

### FreeRide State
- Installed prerequisites on U56E (`python3-pip`, `pipx`).
- Installed `freeride` and `freeride-watcher` via pipx and symlinked into `/usr/local/bin`.
- Set live NanoClaw env defaults to free-tier routing:
  - `OPENROUTER_MODEL_GENERAL=openrouter/openrouter/free`
  - `OPENROUTER_MODEL_CODE=openrouter/qwen/qwen3-next-80b-a3b-instruct:free`
- Restarted NanoClaw after env update.

### Import-ClawHub Audit vs New Upstream Conventions
- Confirmed `.claude/skills/import-clawhub` exists in U56E repo.
- Tested converted runtime skills in `container/skills/*` for:
  - frontmatter validity
  - unresolved OpenClaw markers in runtime-facing files
- Found and patched converter inconsistency:
  - old annotation text triggered its own fail-closed scan
  - changed annotation language to avoid self-trigger
  - updated scan block to include `rg` with `grep` fallback
  - restricted practical scan intent to runtime-facing files (`SKILL.md`, `scripts`, `hooks`, `bin`)
- Normalized converted SKILL files (`free-ride`, `self-improving-agent`):
  - removed UTF-8 BOM causing frontmatter detection issues
  - removed remaining legacy marker lines from runtime-facing docs
- Result: strict runtime marker scan passes for converted skills.

### Gmail OAuth Channel Status
- OAuth client file exists on U56E:
  - `~/.gmail-mcp/gcp-oauth.keys.json`
- OAuth completion now succeeded and credentials file exists:
  - `~/.gmail-mcp/credentials.json`
- Gmail channel is active (connected) after service restart.
- Runtime fix applied: seeded `web:main` chat row to resolve Gmail inbound FK errors on first poll.

### OpenRouter Runtime Fix (Post-Update)
- Corrected invalid model string introduced during FreeRide tuning:
  - from `openrouter/openrouter/free`
  - to `openrouter/free`
- Current live env values:
  - `OPENROUTER_MODEL_GENERAL=openrouter/free`
  - `OPENROUTER_MODEL_CODE=qwen/qwen3-next-80b-a3b-instruct:free`
- This removes host-side 400 errors (`not a valid model ID`) for OpenRouter general routing.

## Update - 2026-03-14 (Today)

### Debate CLI (NanoClaw repo on Dell/workspace)
- Extended `scripts/debate.ts` with explicit provider controls:
  - `--with-gemini` / `--no-gemini`
  - `--with-kimi` / `--no-kimi`
  - `--free-tier-only`
  - `--free-model <model-id>`
- Added startup route/cost benchmark output (`Benchmark: N/100`, FREE/LOW/MEDIUM/HIGH).
- Updated `scripts/lib/pipeline.ts` provider policy gating:
  - `enableGemini`, `enableKimi`, `freeTierOnly`
  - free-tier-only disables paid/escalation paths
  - selected free models and provider availability recorded in `decision.providerPolicy`.

### Web Channel Debate Workbench (U56E `~/projects/nanoclaw-web`)
- Reality check (2026-03-14 PM): live web UI is still on legacy mode set:
  - `default`, `review`, `debate`, `yolo`
  - "Prompt Options + Debate Workbench" header still present
  - source of truth confirmed on U56E at:
    - `~/projects/nanoclaw-web/app/components/NanoClawChat.tsx`
    - `~/projects/nanoclaw-web/app/api/debate/route.ts`
    - `~/projects/nanoclaw-web/app/api/send/route.ts`
- Requested replacement (`free`, `free+low`, `debate`) is NOT deployed yet in live `nanoclaw-web`.

### Miscommunication Root Cause (Postmortem)
- Target ambiguity: work happened in NanoClaw core repo and scripts, while the visible UI is served by a separate repo/service (`nanoclaw-web`) on U56E.
- Completion claimed without live acceptance proof: no required check against the actual rendered page text on `http://<u56e>:3010`.
- Context drift: this file recorded features as completed before validating the running service reflected those changes.
- Pipeline/UI disconnect: `scripts/debate.ts` mode changes in this repo do not automatically update `nanoclaw-web` mode labels or controls.

### Anti-Pitfall Protocol (Mandatory for UI Requests)
1. Target map first:
   - identify exact repo + file + service process that renders user-visible change.
2. Implement only in mapped target:
   - UI text/control changes must be in `nanoclaw-web`, not just NanoClaw core.
3. Deploy + verify:
   - rebuild/restart target service, then confirm by grep + browser check of exact strings.
4. Evidence before "done":
   - record command outputs proving old string removed and new string present.
5. Update context last:
   - mark complete in `projectcontext.md` only after live endpoint verification.

### Prompt Contracts Used in Debate
- Draft prompt asks for fixed implementation sections:
  - `## Summary`, `## Architecture`, `## Implementation Changes`, `## Test Plan`, `## Risks`
  - explicit MVP + Pareto-first instruction.
- Critic prompt requires structured review output:
  - `VERDICT: CLEAN|MINOR|BLOCKING`
  - `AGREEMENTS`, `DISAGREEMENTS`, `HOLES`, `MVP`, `PARETO`, `STYLE_ONLY`
- Rewrite prompt asks drafter to:
  - resolve blockers/holes first
  - keep high-value MVP/Pareto improvements
  - minimize style-only churn.

### Agent Runtime Status (U56E CLIs)
- `gemini` CLI non-interactive mode works.
- `kimi` CLI non-interactive mode works.
- `qwen` CLI installed, but non-interactive mode currently needs auth-type configuration.
  - `POST /api/debate` now supports `QWEN_CLI_AUTH_TYPE` env for `--auth-type`.
  - until set, Qwen failures appear as step-level error cards in UI.

## Current Priorities
1. Validate in browser that deployed web channel shows only `free`, `free+low`, `free+low+high`.
2. Validate "Intermediate Model Responses" panel rendering on a live run.
3. Configure `QWEN_CLI_AUTH_TYPE` so Qwen joins web debate runs reliably.
4. Continue keeping import-clawhub conversions aligned with local-skill upstream conventions.
5. Optical bay HDD rescue/mount still pending.

## Hotfix - 2026-03-14 (Live Web Channel)
- Patched live U56E `nanoclaw-web`:
  - `app/components/NanoClawChat.tsx`
  - `app/api/debate/route.ts`
  - `app/api/send/route.ts`
- Mode set replaced in UI/API:
  - from: `default`, `review`, `debate`, `yolo`
  - to: `free`, `free+low`, `free+low+high`
- Workbench layout updated:
  - middle section now explicitly shows all intermediate per-step model responses
  - bottom section is final result with copy button
- Service rebuilt and restarted; `nanoclaw-web` currently `active`.

## Thermal Diagnostics - 2026-03-14 (U56E)
- Trigger: user reported sustained ~70C vs ~45C three days earlier.
- Live verification from CLI during investigation:
  - `sensors` showed package temps mostly ~53-60C (not sustained 70C during sampling).
  - 2-minute repeated `/sys/class/thermal/thermal_zone*/temp` sampling stayed mostly:
    - `acpitz`: ~50-56C
    - `x86_pkg_temp`: ~54-62C (brief startup peak).
  - Load remained low (typically ~0.05-0.55).
- Process/service findings:
  - User services `nanoclaw` + `nanoclaw-web` are running normally.
  - Stopping these services temporarily did not materially lower thermal readings.
  - Main steady-state CPU users are low-percent system daemons (`valkey`, `immich`, `pihole`, `tailscaled`).
- Historical telemetry (`sar`) findings:
  - Host is mostly idle (>95% idle most windows) with occasional short CPU bursts (likely scheduled maintenance).
  - `apt-daily` / `apt-daily-upgrade` show periodic CPU bursts in journal history.
- Thermal control stack findings:
  - `thermald` is active but logs repeated sensor/zone limitations (`No temp sysfs`, `No Zones present Need to configure manually` in some boots).
  - This may contribute to inconsistent thermal behavior on this older ASUS platform.
- Constraint:
  - Effective mitigation (CPU governor/turbo caps, thermald config, root service tuning) requires `sudo`; current non-interactive session does not have root privileges.

### Friction Ledger Entry
- Date: 2026-03-14
- Task: Reduce sustained U56E thermals back toward ~45C baseline
- Blocker: Root-only thermal controls unavailable in non-interactive automation session
- Classification: Workflow gap
- Impact: Cannot apply durable thermal caps/config without user-mediated privilege escalation
- Durable Fix Path: Repo change + runbook (document a one-shot root hardening script and execution checklist)
- Owner: jaman
- Status: closed

### Remediation Applied (2026-03-14, root-level)
- Added persistent thermal cap unit:
  - `/etc/systemd/system/u56e-cooldown.service`
  - enabled and active (`systemctl is-enabled/is-active`: `enabled` / `active`)
- Service actions on boot:
  - `cpupower frequency-set -g powersave`
  - `cpupower frequency-set -u 1.20GHz`
  - `echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo`
- Verification:
  - `no_turbo=1` confirmed
  - policy shows max frequency capped at `1.20GHz`
  - user services remain healthy: `nanoclaw` and `nanoclaw-web` both `active`
  - post-change thermal sampling remained mostly in ~`50-56C` band during low-to-moderate load
- Interpretation:
  - peak behavior improved/stabilized, but not a full return to ~45C baseline
  - likely remaining contributors: ambient conditions, firmware/ACPI sensor quirks on this platform, and non-user service background activity

## Update - 2026-03-16 (Debate Pipeline v4 execution)

### Scope completed in this repo
- Implemented v4 hardening in:
  - `scripts/lib/pipeline.ts`
  - `scripts/debate.ts`
  - `scripts/lib/artifacts.ts`
  - provider/rubric support files already aligned (`scripts/lib/providers.ts`, `scripts/lib/rubric.ts`)

### Key behavior now in place
- Retry progress is stable across retries:
  - retries increment `attempt` metadata only
  - logical `stepIndex/expectedSteps` do not advance per retry
- Added round-boundary free quota gate:
  - new status `QUOTA_EXHAUSTED`
  - fails before starting the next round and preserves prior-best output
- Added pre-critic size compaction path:
  - oversized drafts are compacted before critic prompt fan-out
- Added caller-level fast skip for repair/compact:
  - if structural rubric passes and spec is in budget, repair flow is skipped
- Added repair temperature control:
  - config/env `SPEC_REPAIR_TEMPERATURE` (default `0.1`)
  - repair/compact calls use repair temperature, not draft temperature
- Added `userNotes` plumbing:
  - `PipelineInput.userNotes?: string`
  - CLI flags `--user-notes`, `--user-notes-file`
  - prompt ordering standardized (constraints -> goal -> user notes -> memory -> instructions -> spec)
- High-tier critics are parallelized:
  - Codex + Claude run with `Promise.allSettled`
  - rejected fan-out entries are recorded in `decision.notes`
- Resume/history/status wiring confirmed:
  - `--resume` + checkpoint JSON path writing
  - `--keep-history` writes `spec-history.jsonl` + cleanup
  - artifact banner includes `QUOTA_EXHAUSTED`

### Validation evidence (2026-03-16)
- Typecheck:
  - `npx tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext scripts/lib/providers.ts scripts/lib/rubric.ts scripts/lib/pipeline.ts scripts/debate.ts scripts/lib/artifacts.ts` -> pass
- CLI contract:
  - `npm run -s debate -- --help` -> includes `--user-notes`, `--user-notes-file`, updated exit-code semantics
- Runtime smoke:
  - quota smoke (`SPEC_FREE_PROMPT_DAILY_LIMIT=0`) -> `QUOTA_EXHAUSTED` before round start
  - resume smoke (`--resume ...`) -> `NO_HIGH_TIER` with `resumeFrom: high` + checkpoint path
  - stream JSON events show stable retry progress (`attempt` increments while `stepIndex` remains constant)
- Full test suite:
  - `npm test` currently fails 2 unrelated existing tests:
    - `setup/platform.test.ts` (`commandExists('node')` assertion)
    - `src/channels/web.test.ts` (`xTrim` signature expectation drift)

## Update - 2026-03-16 (Debate Pipeline v4.1)

### Scope completed
- `scripts/lib/pipeline.ts`
  - dedicated CLI exit-code mapping for `QUOTA_EXHAUSTED` (`14`)
  - free-call projection updated from fixed `3` to mode/provider-aware baseline:
    - `free`: `2`
    - `free+low`/`debate`: `2` (+`1` conservative fallback only when low-tier critics are unavailable)
    - `resume`: `0`
  - free-call counting now strictly matches `openrouter:<model ending in :free>`
  - low-tier rewrite target resolved once and reused for rewrite + repair/compact
  - high-tier `Promise.allSettled` rejection handling now materializes unavailable critics with error metadata
  - if no high-tier critics are available, high-tier rewrite is skipped and low-tier checkpoint result is returned
  - rewrite prompt ordering updated: critique feedback appears before current spec
  - added `PIPELINE_TEST_ONLY` export for pure helper tests
- `scripts/debate.ts`
  - help text now shows dedicated quota exit code
  - history write/cleanup wrapped in try/catch to avoid fatal run termination on history I/O failures
- `src/debate-pipeline.test.ts`
  - added focused tests for:
    - free-call estimation
    - strict free-call counting
    - rewrite prompt ordering
    - `QUOTA_EXHAUSTED` exit code mapping

### Validation evidence (v4.1)
- Targeted tests:
  - `npx vitest run src/debate-pipeline.test.ts` -> pass (6 tests)
- Typecheck:
  - `npx tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext scripts/lib/providers.ts scripts/lib/rubric.ts scripts/lib/pipeline.ts scripts/debate.ts scripts/lib/artifacts.ts src/debate-pipeline.test.ts` -> pass
- Runtime smoke:
  - forced high-tier critic failures in resume-mode debate -> status `NO_HIGH_TIER`
  - `decision.notes` confirms: `High-tier critics unavailable; skipping high-tier rewrite...`
- Full suite remains with 2 pre-existing unrelated failures:
  - `setup/platform.test.ts` (`commandExists('node')`)
  - `src/channels/web.test.ts` (`xTrim` signature expectation drift)

## Update - 2026-03-16 (Debate Pipeline v4.2 core)

### Scope completed in this repo
- `scripts/lib/pipeline.ts`
  - added goal normalization gate for oversized goals (`>3000 chars`) with one free-route summarization call
  - added hard post-summary clamp (`<=500 words`, `<=3000 chars`)
  - normalized goal now used throughout draft/critic/rewrite/repair flows; raw goal no longer propagates through all prompts
  - added `STOPPED` status and cooperative abort checks (round boundaries, step dispatch, retry iterations)
  - added dedicated stop exit code mapping (`130`)
  - added contamination tracking in decision (`containsReviewMetadata`, `reviewMetadataMarkers`)
  - hardened rewrite prompt against critique bleed-through
  - sanitizer now strips section-header review metadata blocks after model outputs
- `scripts/lib/rubric.ts`
  - structural rubric now detects review metadata markers and fails contamination cases
  - added `stripReviewMetadataSections` and `detectReviewMetadataMarkers` helpers with header-style matching only
- `scripts/lib/artifacts.ts`
  - added `STOPPED` status banner
- `scripts/debate.ts`
  - CLI default mode set to `free+low`
  - help text includes `STOPPED` exit code (`130`)
  - artifact title/slug now uses normalized goal (`result.decision.goal`)
- `src/debate-pipeline.test.ts`
  - expanded coverage for v4.2:
    - goal summary clamp behavior
    - contamination stripping/detection behavior
    - stopped status + exit code

### Validation evidence (v4.2 core)
- Targeted tests:
  - `npx vitest run src/debate-pipeline.test.ts` -> pass (11 tests)
- Typecheck:
  - `npx tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext scripts/lib/pipeline.ts scripts/lib/rubric.ts scripts/debate.ts scripts/lib/artifacts.ts src/debate-pipeline.test.ts` -> pass
- Full suite:
  - `npm test` unchanged failure profile (2 pre-existing unrelated failures):
    - `setup/platform.test.ts` (`commandExists('node')`)
    - `src/channels/web.test.ts` (`xTrim` signature expectation drift)

### Current constraint
- `nanoclaw-web` repo/service is not present in this local workspace path, so web stop endpoint/button and web workbench default mapping changes were not applied here.

## Update - 2026-03-16 (U56E web patch + repo consolidation + upstream merge)

### nanoclaw-web (U56E runtime folder, not git-managed)
- Patched live files on U56E under `~/projects/nanoclaw-web`:
  - `app/components/NanoClawChat.tsx`
  - `app/api/debate/route.ts`
  - `app/api/debate/run-state.ts` (new)
  - `app/api/debate/stop/route.ts` (new)
- Applied requested defaults:
  - mode default: `free+low`
  - rounds default: `1`
  - tier preset:
    - free: drafter `gemini-cli`, critic `qwen-cli`
    - low: drafter `kimi-cli`, critic `gemini-cli`
- Added stop path:
  - frontend stop button calls `POST /api/debate/stop`
  - backend tracks active debate child process and sends `SIGINT` then `SIGKILL` fallback.
- Rebuilt and restarted service:
  - `npm run build` pass
  - `systemctl --user restart nanoclaw-web`
  - service active on port `3010`.

### nanoclaw repo consolidation (Dell <-> GitHub <-> U56E)
- Dell local committed and pushed `main` updates for debate pipeline hardening + tests.
- U56E `~/projects/nanoclaw` fast-forwarded to match `origin/main`.
- Merged upstream `qwibitai/main` into local `main` with conflict resolution:
  - conflicted files: `package.json`, `package-lock.json`, `src/index.ts`
  - resolved to preserve local runtime integrations while accepting upstream non-conflicting additions.
- Pushed merged `main` to origin and fast-forwarded U56E again.
- Verified commit identity:
  - local HEAD = `b1768cf0c33c86e050da34b7aa69d4dca5221380`
  - U56E HEAD = same
  - `origin/main` = same.

### Validation evidence (consolidation cycle)
- Local tests:
  - `npm run test -- src/debate-pipeline.test.ts src/remote-control.test.ts setup/service.test.ts` -> pass
- Local build:
  - `npm run build` -> pass (after excluding `src/debate-pipeline.test.ts` from `tsconfig` build graph)
- U56E web:
  - `npm run build` in `~/projects/nanoclaw-web` -> pass
  - `systemctl --user status nanoclaw-web` -> active.

### Friction Ledger Entry
- Date: 2026-03-16
- Task: Keep Dell/U56E/GitHub in lockstep while also shipping `nanoclaw-web` UI/API changes
- Blocker: `nanoclaw-web` on U56E is deployed from a non-git folder; no canonical remote/history for clean multi-host sync
- Classification: Workflow gap
- Impact: Runtime web fixes are not automatically reproducible or auditable from GitHub history
- Durable Fix Path: Repo change (promote `nanoclaw-web` to its own git repo with origin remote; add pull/restart deploy script)
- Owner: jaman
- Status: open

## Update - 2026-03-17 (Debate simplification pass)

### Simplifications applied (core `nanoclaw` repo)
- Increased default per-call timeout for debate pipeline calls:
  - `SPEC_PER_CALL_TIMEOUT_MS` default now `180000` ms
- Tightened draft/rewrite/repair/compact prompt contracts:
  - enforce only required spec sections in fixed order
  - disallow extra top-level sections
- Stopped warning fallback text from being injected into post-review/spec content when no reviewer sections exist.
- Terminal output separation improved:
  - generated spec is bounded by explicit begin/end markers
  - review notes print in a separate block outside spec markers.

### Simplifications applied (live `nanoclaw-web` on U56E)
- `~/projects/nanoclaw-web/app/api/debate/route.ts`:
  - CLI timeout now env-driven (`WEB_DEBATE_CLI_TIMEOUT_MS`, default `180000`)
  - rewrite prompt now puts critique before current spec and bans reviewer/meta sections in output
  - removed final synthesis/fallback plan step (which produced `Discarded Agent Ideas`, `Open Questions`, and warning bleed)
  - final result now uses converged `finalSpec` directly
- Rebuilt and restarted `nanoclaw-web` successfully.

### Validation evidence
- Local core:
  - `npm run test -- src/debate-pipeline.test.ts` -> pass
  - `npm run build` -> pass
- U56E web:
  - `npm run build` in `~/projects/nanoclaw-web` -> pass
  - `systemctl --user status nanoclaw-web` -> active
- Sync:
  - local + origin + U56E `nanoclaw` HEAD synchronized at `60773d31d43495efecfaa82759cf1b7f72af4d00`.

