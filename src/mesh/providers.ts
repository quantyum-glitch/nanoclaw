import { MeshDecision, MeshJob } from './types.js';

const DEFAULT_TIMEOUT_MS = 90_000;

type JsonObject = Record<string, unknown>;

function getEnv(key: string): string | undefined {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return JSON.parse(text) as JsonObject;
  } finally {
    clearTimeout(timer);
  }
}

function extractMessageContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (
          item &&
          typeof item === 'object' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          return item.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

async function callOpenRouter(prompt: string): Promise<string> {
  const apiKey =
    getEnv('OPENROUTER_API_KEY') ||
    getEnv('OPENROUTER_AUTH_TOKEN') ||
    getEnv('ANTHROPIC_AUTH_TOKEN');
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY (or OPENROUTER_AUTH_TOKEN/ANTHROPIC_AUTH_TOKEN) is required',
    );
  }

  const model = getEnv('OPENROUTER_MODEL_GENERAL') || 'openrouter/free';
  const data = await fetchJson('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  const choices = Array.isArray(data.choices)
    ? (data.choices as Array<Record<string, unknown>>)
    : [];
  const first = choices[0];
  const message =
    first && typeof first === 'object'
      ? (first.message as Record<string, unknown> | undefined)
      : undefined;
  const content = extractMessageContent(message?.content);
  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }
  return content;
}

async function callKimi(prompt: string): Promise<string> {
  const apiKey = getEnv('KIMI_API_KEY');
  if (!apiKey) {
    return 'Kimi critique skipped: missing KIMI_API_KEY.';
  }

  const model = getEnv('KIMI_MODEL') || 'moonshot-v1-8k';
  const endpoint =
    getEnv('KIMI_BASE_URL') || 'https://api.moonshot.ai/v1/chat/completions';
  const data = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  const choices = Array.isArray(data.choices)
    ? (data.choices as Array<Record<string, unknown>>)
    : [];
  const first = choices[0];
  const message =
    first && typeof first === 'object'
      ? (first.message as Record<string, unknown> | undefined)
      : undefined;
  const content = extractMessageContent(message?.content);
  if (!content) {
    return 'Kimi critique empty; treating as neutral.';
  }
  return content;
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) {
    return 'Gemini critique skipped: missing GEMINI_API_KEY.';
  }

  const model = getEnv('GEMINI_MODEL') || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  const candidates = Array.isArray(data.candidates)
    ? (data.candidates as Array<Record<string, unknown>>)
    : [];
  const first = candidates[0] || {};
  const content =
    first && typeof first === 'object'
      ? (first.content as Record<string, unknown> | undefined)
      : undefined;
  const parts = Array.isArray(content?.parts)
    ? (content.parts as Array<Record<string, unknown>>)
    : [];
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    return 'Gemini critique empty; treating as neutral.';
  }
  return text;
}

function evaluateDraft(draft: string): {
  score: number;
  rubric: MeshDecision['rubric'];
} {
  const hasSummary = /(^|\n)#+\s*summary\b/i.test(draft);
  const hasArchitecture = /(^|\n)#+\s*(architecture|design|approach)\b/i.test(
    draft,
  );
  const hasTests = /(^|\n)#+\s*(test|validation)\b/i.test(draft);
  const hasRisks = /(^|\n)#+\s*(risk|failure|edge case)\b/i.test(draft);
  const score =
    (hasSummary ? 2 : 0) +
    (hasArchitecture ? 2 : 0) +
    (hasTests ? 2 : 0) +
    (hasRisks ? 2 : 0);

  return {
    score,
    rubric: { hasSummary, hasArchitecture, hasTests, hasRisks },
  };
}

function mergeSummary(geminiCritique: string, kimiCritique: string): string {
  return [
    'Consensus summary from critics:',
    '',
    'Gemini:',
    geminiCritique,
    '',
    'Kimi:',
    kimiCritique,
  ].join('\n');
}

function initialDraftPrompt(job: MeshJob): string {
  return [
    'You are producing a software implementation spec.',
    `Goal: ${job.goal}`,
    `Constraints: ${job.constraints.join('; ') || 'none'}`,
    'Output markdown with sections:',
    '1) Summary',
    '2) Architecture',
    '3) Implementation Changes',
    '4) Test Plan',
    '5) Risks',
  ].join('\n');
}

function rewritePrompt(
  job: MeshJob,
  currentDraft: string,
  geminiCritique: string,
  kimiCritique: string,
): string {
  return [
    'Revise this implementation spec using critiques.',
    `Goal: ${job.goal}`,
    '',
    'Current draft:',
    currentDraft,
    '',
    'Gemini critique:',
    geminiCritique,
    '',
    'Kimi critique:',
    kimiCritique,
    '',
    'Return improved markdown with sections:',
    'Summary, Architecture, Implementation Changes, Test Plan, Risks.',
  ].join('\n');
}

export async function runDebate(job: MeshJob): Promise<{
  finalSpec: string;
  decision: MeshDecision;
}> {
  let draft = await callOpenRouter(initialDraftPrompt(job));
  let lastDecision: MeshDecision | null = null;

  for (let round = 1; round <= job.maxRounds; round += 1) {
    const [geminiCritique, kimiCritique] = await Promise.all([
      callGemini(
        `Critique this spec. Focus on feasibility, missing details, and testability.\n\n${draft}`,
      ),
      callKimi(
        `Critique this spec. Focus on architecture risks and execution pitfalls.\n\n${draft}`,
      ),
    ]);

    const { score, rubric } = evaluateDraft(draft);
    const passed = score >= 6;

    lastDecision = {
      summary: mergeSummary(geminiCritique, kimiCritique),
      score,
      passed,
      round,
      draft,
      geminiCritique,
      kimiCritique,
      rubric,
    };

    if (passed || round === job.maxRounds) {
      return { finalSpec: draft, decision: lastDecision };
    }

    draft = await callOpenRouter(
      rewritePrompt(job, draft, geminiCritique, kimiCritique),
    );
  }

  if (!lastDecision) {
    throw new Error('Debate failed before producing a decision');
  }
  return { finalSpec: lastDecision.draft, decision: lastDecision };
}

