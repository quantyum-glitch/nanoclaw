# OpenCode + OpenRouter Workflow

This repo can be developed without Claude Code by using OpenCode with OpenRouter.

## 1. Configure OpenRouter

Set your API key:

```bash
export OPENROUTER_API_KEY="..."
```

Optional defaults:

```bash
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"
export OPENROUTER_DEBATE_MODELS="openrouter/free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-coder:free"
export OPENROUTER_SYNTH_MODEL="openrouter/free"
```

## 2. Run Multi-LLM Critique First

Before large edits, run:

```bash
npm run llm:debate -- --prompt "Implement X with tests and rollback plan"
```

Use the synthesis output as the prompt you give to OpenCode/Cline/Gemini.

## 3. Suggested Near-Zero-Cost Routing

- Default to free models.
- Escalate to paid models only for blocked tasks.
- Enforce provider-side daily budget/rate caps.

## 4. Local NanoClaw Runtime Variables

For Anthropic-compatible routing in NanoClaw runner:

```bash
ANTHROPIC_BASE_URL=...
ANTHROPIC_AUTH_TOKEN=...
```

Keep expensive endpoints disabled unless explicitly needed.

## Related Docs

- `docs/CODING_AGENTS.md`
- `docs/FREE_LLM_DEBATE.md`
- `docs/BRAINS_PLAN.md`
- `docs/OBSERVABILITY.md`
