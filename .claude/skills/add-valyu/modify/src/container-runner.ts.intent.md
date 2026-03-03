## Intent

Adds Valyu and Anthropic-compatible endpoint secrets to container stdin passthrough, and restores `.env` shadowing for main-group project mounts.

## Must Keep

- `.env` remains shadowed at `/workspace/project/.env` when it exists.
- Existing Gmail mount behavior remains unchanged.
- Secret passthrough remains explicit allowlist-only.
