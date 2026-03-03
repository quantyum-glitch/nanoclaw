# Observability Notes

NanoClaw now emits additional structured logs for runtime visibility.

## Startup Logs

- DB backend selection (`better-sqlite3` or `sqljs-shim`)
- Runtime info (`platform`, `nodeVersion`, `pid`)
- Connected channel list/count

## Container Host Logs (`src/container-runner.ts`)

- Secret passthrough metadata (key names only, never values)
- Container spawn metadata (group, mount count, duration)
- Timeout and idle cleanup outcomes

## Agent Runner Logs (`container/agent-runner/src/index.ts`)

- Enabled MCP server names/count per query
- Allowed tool pattern count
- Query duration + result counts

## Quick Filtering

Use `LOG_LEVEL=debug` for deep tracing.

Examples:

```bash
LOG_LEVEL=debug npm run dev
```

```bash
npm run dev | rg "Database backend selected|MCP servers enabled|Container completed"
```

## Windows Shim Telemetry

Set `NANOCLAW_USE_SQLITE_SHIM=1` to force sql.js backend.
Startup logs will explicitly show `dbEngine: sqljs-shim`.
