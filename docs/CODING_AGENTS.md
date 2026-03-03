# Coding Agent Workflows (OpenCode, Cline, Gemini, Aider)

Use NanoClaw runtime as-is, and use external coding agents from your terminal/editor.

## 1) OpenCode + OpenRouter (default)

1. Set env vars:
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_BASE_URL` (optional, default `https://openrouter.ai/api/v1`)
2. Use free-model debate to tighten prompts before edits:
   - `npm run llm:debate -- --prompt "Implement feature X with tests"`

## 2) Cline (VS Code)

1. Install Cline extension in VS Code (inside WSL remote workspace).
2. Provider choice:
   - OpenRouter key for low/zero-cost rotation.
   - Gemini key for Google-native model access.
3. Recommended prompt style:
   - "Work in small commits, run typecheck + targeted tests after each change, summarize risks first."

## 3) Gemini Code Assist

1. Use Gemini Code Assist in VS Code for fast code generation/review loops.
2. Keep NanoClaw runtime/tests as source of truth:
   - `npm run typecheck`
   - `npm test -- src/<changed-file>.test.ts`
3. Use OpenRouter debate script first for adversarial critique when output quality matters.

## 4) Aider (terminal)

1. Install aider globally or per-project.
2. Route models via OpenRouter/Gemini depending on your key setup.
3. Keep guardrails:
   - Ask for explicit test plan.
   - Require diff summary before write.

## Practical Pattern

1. Run `npm run llm:debate` to get draft + critiques + synthesis.
2. Feed synthesized prompt to OpenCode/Cline/Gemini/Aider.
3. Accept only changes that pass local validation.
4. If models disagree, keep the stricter safety/test suggestion.
