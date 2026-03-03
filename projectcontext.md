# NanoClaw Project Context

## High-level technical architecture & requirements
- **What it is**: NanoClaw is a lightweight, customizable personal AI (Claude) assistant built to run locally and securely.
- **Architecture**: Single Node.js orchestrator process (`src/index.ts`). Channels (e.g., WhatsApp, Telegram) are registered via skills. Uses `better-sqlite3` for local state/memory storage.
- **Isolation/Security**: Agents run securely inside isolated Linux containers. No direct host bash access; only explicitly mounted directories are exposed.
- **Customization**: Uses code generation/modification via Claude skills instead of sprawling configuration files. 

## Domain context & design patterns in use
- **Skills System**: Modifications are triggered via specialized `/`-commands (skills) that transform the Node.js source directly rather than tweaking `.env` or config files.
- **Container Runtime**: Demands a container runtime (Docker or Apple Container). NanoClaw executes standard `docker` commands to spin up execution environments.

## Decisions and the WHY behind them
- Initialized baseline `projectcontext.md`. No code edits performed yet.
- **Startup crash diagnosis**: App failed during `npm run dev` in `container-runtime.ts` due to missing `docker` binary in the PATH. The app strictly requires a container engine to securely isolate AI agent execution.

## Relevant code pointers, config files, gatekeeping rules
- *Rules*: Follow `AGENTS.md` exactly. Always operate from root. Use validate loop. Never assume code works. Only update this file with concise, curated information.
- *Entry*: `src/index.ts`
- *Windows Setup*: According to `README.md`, Windows users should run NanoClaw in WSL2 (Windows Subsystem for Linux). See `docs/WSL2_SETUP.md`.

## Active TODO list for current work
- [ ] Resolve container runtime issue: Ensure Docker Desktop is installed and added to PATH, or migrate execution to WSL2.

## Lessons learned from failures
- (Empty)
