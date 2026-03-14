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
- Added authenticated debate endpoint:
  - `POST /api/debate`
  - session cookie required (same web auth model).
- Added full web UI workbench:
  - mode radios (`default`, `review`, `debate`, `yolo`)
  - agent checkboxes (`Gemini CLI`, `Qwen CLI`, `Kimi CLI`)
  - per-agent benchmark row (cost/speed/critique/reliability)
  - single overall benchmark score
  - prompt input box
  - step-by-step run cards with:
    - exact prompt sent
    - per-model output/error
    - timing
  - separate final boxes:
    - convergence
    - disagreements/holes
    - final result/spec
  - copy button for final result.
- Service notes:
  - `nanoclaw-web` rebuilt successfully
  - restart required killing one orphan `next-server` process before clean start.

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
1. Configure `QWEN_CLI_AUTH_TYPE` so Qwen joins web debate runs reliably.
2. Add explicit role pinning in web debate UI (choose drafter vs critic agents directly).
3. Add hard blocker gate policy in web output (pass/fail with unresolved blocker count).
4. Continue keeping import-clawhub conversions aligned with local-skill upstream conventions.
5. Optical bay HDD rescue/mount still pending.

