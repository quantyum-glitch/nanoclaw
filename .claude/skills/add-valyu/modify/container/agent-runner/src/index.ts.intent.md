## Intent

Adds optional Valyu MCP server configuration and tool allowlist expansion.

## Must Keep

- Existing `nanoclaw` and `gmail` MCP servers stay active.
- Valyu server is only added when `VALYU_API_KEY` is present.
- Tool namespace `mcp__valyu__*` is only enabled when Valyu server is configured.
