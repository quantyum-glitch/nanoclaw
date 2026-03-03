# Free LLM Debate Workflow

This repo includes a host-side script to run a "model critique/fight" flow against OpenRouter models.

## Why

- Catch weak assumptions before code changes.
- Use multiple free models without changing NanoClaw core runtime.
- Keep inference spend near zero by default.

## Commands

1. Discover current free models:

```bash
npm run llm:list-free
```

2. Run debate on a task:

```bash
npm run llm:debate -- --prompt "Design a safe migration plan for X"
```

3. Use a prompt file:

```bash
npm run llm:debate -- --file prompts/task.txt
```

## Chat Commands (WhatsApp/Gmail/Main Chat)

- `/free-models` or `*free-models`
- `/debate <prompt>` or `*debate <prompt>`
- `/llm-help`

## Env Variables

- `OPENROUTER_API_KEY` (required)
- `OPENROUTER_BASE_URL` (optional)
- `OPENROUTER_DEBATE_MODELS` (comma-separated model IDs)
- `OPENROUTER_SYNTH_MODEL` (optional override)

## Default Debate Roles

- Primary model: writes first draft.
- Critic models: attack draft assumptions/risk gaps.
- Synthesis model: merges valid critiques and emits final answer.

## Recommended Defaults

Use free models and keep the first model stable so outputs are comparable across runs.

Example:

```bash
OPENROUTER_DEBATE_MODELS=openrouter/free,meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-coder:free,google/gemma-3-27b-it:free
OPENROUTER_SYNTH_MODEL=openrouter/free
```

## Safety

- Treat outputs as advisory, not authoritative.
- Always run local typecheck/tests before accepting changes.
- Do not pass secrets into debate prompts.
