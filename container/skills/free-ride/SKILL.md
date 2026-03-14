---
name: freeride
description: Configure and use FreeRide CLI with NanoClaw to prioritize free OpenRouter models and resilient fallbacks.
---

> NanoClaw Compatible: Converted from legacy ClawHub skill.

# FreeRide for NanoClaw

Use FreeRide when the user wants low-cost/free model routing.

## Prerequisites

- `OPENROUTER_API_KEY` is set in `.env`
- `freeride` CLI is installed and available in PATH

## Core workflow

1. Set up free-model routing:

```bash
freeride auto
```

2. Verify status:

```bash
freeride status
```

3. Show models:

```bash
freeride list -n 20
```

## Common commands

- `freeride auto -f` -> update fallbacks without changing primary
- `freeride switch <model>` -> switch primary to a specific free model
- `freeride fallbacks` -> refresh fallback chain
- `freeride refresh` -> refresh model cache

## Notes for NanoClaw

- Do not run legacy platform-specific commands.
- Do not edit legacy platform config files.
- Keep all model/API config in NanoClaw `.env` and runtime settings.
- If configuration changes need to take effect, restart NanoClaw.
