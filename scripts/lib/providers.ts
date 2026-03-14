import { spawn } from 'node:child_process';

type OpenRouterMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ProviderCallOptions {
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
}

export interface ProviderResult {
  text: string;
  model: string;
  provider: string;
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function mustGetEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function isTrue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

function decodeEscapedText(input: string): string {
  return input
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .trim();
}

async function runCliCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      if (finished) return;
      finished = true;
      reject(new Error(`${command} execution failed: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (finished) return;
      finished = true;
      resolve({
        stdout,
        stderr,
        code: code ?? 1,
        signal,
      });
    });
  });
}

function extractKimiCliText(rawOutput: string, prompt: string): string {
  const clean = stripAnsi(rawOutput).trim();
  if (!clean) return '';

  const textParts: string[] = [];
  const singleQuotePattern = /TextPart\([^)]*text='((?:\\'|[^'])*)'/g;
  const doubleQuotePattern = /TextPart\([^)]*text="((?:\\"|[^"])*)"/g;

  for (const match of clean.matchAll(singleQuotePattern)) {
    textParts.push(decodeEscapedText(match[1]));
  }
  for (const match of clean.matchAll(doubleQuotePattern)) {
    textParts.push(decodeEscapedText(match[1]));
  }
  if (textParts.length > 0) return textParts.join('\n').trim();

  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== prompt)
    .filter(
      (line) =>
        !line.startsWith('TurnBegin(') &&
        !line.startsWith('StepBegin(') &&
        !line.startsWith('ThinkPart(') &&
        !line.startsWith('StatusUpdate(') &&
        !line.startsWith('ToolCall(') &&
        !line.startsWith('ToolResult('),
    );
  if (lines.length === 0) return '';
  return lines[lines.length - 1].trim();
}

async function callGeminiCli(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const command = getEnv('GEMINI_CLI_COMMAND') || 'gemini';
  const cliModel = getEnv('GEMINI_CLI_MODEL');
  const args = ['-p', prompt, '--output-format', 'text'];
  if (cliModel && cliModel !== 'gemini-cli') {
    args.push('-m', cliModel);
  }
  const result = await runCliCommand(command, args, options.timeoutMs, {
    NO_COLOR: '1',
    CLICOLOR: '0',
  });
  const text = stripAnsi(result.stdout).trim();
  if (result.code !== 0) {
    throw new Error(
      `Gemini CLI failed (exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''}): ${stripAnsi(result.stderr || result.stdout).slice(0, 400)}`,
    );
  }
  if (!text) {
    throw new Error(`Gemini CLI returned empty content: ${stripAnsi(result.stderr).slice(0, 300)}`);
  }
  return {
    text,
    model: cliModel || 'gemini-cli',
    provider: 'gemini-cli',
  };
}

async function callKimiCli(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const command = getEnv('KIMI_CLI_COMMAND') || 'kimi';
  const args = ['--print', '-p', prompt];
  const result = await runCliCommand(command, args, options.timeoutMs, {
    NO_COLOR: '1',
    CLICOLOR: '0',
  });
  if (result.code !== 0) {
    throw new Error(
      `Kimi CLI failed (exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''}): ${stripAnsi(result.stderr || result.stdout).slice(0, 400)}`,
    );
  }
  const text = extractKimiCliText(result.stdout, prompt);
  if (!text) {
    throw new Error(
      `Kimi CLI returned empty/unknown format: ${stripAnsi(result.stdout || result.stderr).slice(0, 400)}`,
    );
  }
  if (/invalid_authentication_error|incorrect_api_key|unauthorized/i.test(text)) {
    throw new Error(`Kimi CLI auth error: ${text.slice(0, 300)}`);
  }
  return {
    text,
    model: getEnv('KIMI_CLI_MODEL') || 'kimi-cli',
    provider: 'kimi-cli',
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractOpenRouterText(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices)
    ? (data.choices as Array<Record<string, unknown>>)
    : [];
  const first = choices[0];
  const message =
    first && typeof first === 'object'
      ? (first.message as Record<string, unknown> | undefined)
      : undefined;
  const content = message?.content;

  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
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

function extractGeminiText(data: Record<string, unknown>): string {
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
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
}

function extractAnthropicText(data: Record<string, unknown>): string {
  const content = Array.isArray(data.content)
    ? (data.content as Array<Record<string, unknown>>)
    : [];
  return content
    .map((item) => {
      if (item?.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }
      return '';
    })
    .join('\n')
    .trim();
}

async function parseJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON response: ${(err as Error).message}`);
  }
}

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  options: ProviderCallOptions & { model: string },
): Promise<ProviderResult> {
  const apiKey =
    getEnv('OPENROUTER_API_KEY') ||
    getEnv('OPENROUTER_AUTH_TOKEN') ||
    getEnv('ANTHROPIC_AUTH_TOKEN');
  if (!apiKey) {
    throw new Error(
      'Missing OPENROUTER_API_KEY (or OPENROUTER_AUTH_TOKEN/ANTHROPIC_AUTH_TOKEN)',
    );
  }

  const baseUrl = getEnv('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1';
  const response = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxOutputTokens,
      }),
    },
    options.timeoutMs,
  );
  const data = await parseJsonResponse(response);
  const text = extractOpenRouterText(data);
  if (!text) {
    throw new Error(`OpenRouter model ${options.model} returned empty content`);
  }
  return {
    text,
    model: options.model,
    provider: 'openrouter',
  };
}

export async function callGemini(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const errors: string[] = [];
  const useCli = isTrue(getEnv('GEMINI_USE_CLI'));
  const apiKey = getEnv('GEMINI_API_KEY');

  if (apiKey) {
    const model = getEnv('GEMINI_MODEL') || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: options.temperature ?? 0.2,
              maxOutputTokens: options.maxOutputTokens,
            },
          }),
        },
        options.timeoutMs,
      );
      const data = await parseJsonResponse(response);
      const text = extractGeminiText(data);
      if (!text) throw new Error(`Gemini model ${model} returned empty content`);
      return {
        text,
        model,
        provider: 'gemini',
      };
    } catch (err) {
      errors.push(`gemini-api: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (useCli) {
    try {
      return await callGeminiCli(prompt, options);
    } catch (err) {
      errors.push(`gemini-cli: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length === 0) throw new Error('Missing GEMINI_API_KEY.');
  throw new Error(`Gemini request failed. ${errors.join(' | ')}`);
}

export async function callKimi(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const apiKey = getEnv('KIMI_API_KEY');
  const model = getEnv('KIMI_MODEL') || 'moonshot-v1-8k';
  const useCli = isTrue(getEnv('KIMI_USE_CLI'));
  const configuredEndpoint = getEnv('KIMI_BASE_URL');
  const endpoints = configuredEndpoint
    ? [configuredEndpoint]
    : [
        'https://api.moonshot.cn/v1/chat/completions',
        'https://api.moonshot.ai/v1/chat/completions',
      ];

  const errors: string[] = [];
  if (useCli) {
    try {
      return await callKimiCli(prompt, options);
    } catch (err) {
      errors.push(`kimi-cli: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!apiKey && !useCli) {
    throw new Error('Missing KIMI_API_KEY.');
  }

  for (const endpoint of endpoints) {
    if (!apiKey) break;
    try {
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxOutputTokens,
          }),
        },
        options.timeoutMs,
      );
      const data = await parseJsonResponse(response);
      const text = extractOpenRouterText(data);
      if (!text) throw new Error(`Kimi model ${model} returned empty content`);
      return {
        text,
        model,
        provider: 'kimi',
      };
    } catch (err) {
      errors.push(`${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const hasOpenRouter =
    getEnv('OPENROUTER_API_KEY') ||
    getEnv('OPENROUTER_AUTH_TOKEN') ||
    getEnv('ANTHROPIC_AUTH_TOKEN');
  if (hasOpenRouter) {
    const fallbackModel = getEnv('KIMI_OPENROUTER_MODEL') || 'moonshotai/kimi-k2';
    try {
      const fallback = await callOpenRouter([{ role: 'user', content: prompt }], {
        model: fallbackModel,
        maxOutputTokens: options.maxOutputTokens,
        timeoutMs: options.timeoutMs,
        temperature: options.temperature,
      });
      return {
        text: fallback.text,
        model: fallback.model,
        provider: 'openrouter-kimi-fallback',
      };
    } catch (err) {
      errors.push(
        `openrouter:${fallbackModel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(`Kimi request failed. ${errors.join(' | ')}`);
}

export async function callAnthropic(
  prompt: string,
  options: ProviderCallOptions & { model: string },
): Promise<ProviderResult> {
  const apiKey = mustGetEnv('ANTHROPIC_API_KEY');
  const endpoint = getEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com/v1';
  const response = await fetchWithTimeout(
    `${endpoint}/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxOutputTokens,
        temperature: options.temperature ?? 0.2,
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    options.timeoutMs,
  );
  const data = await parseJsonResponse(response);
  const text = extractAnthropicText(data);
  if (!text) {
    throw new Error(`Anthropic model ${options.model} returned empty content`);
  }
  return {
    text,
    model: options.model,
    provider: 'anthropic',
  };
}

export function getDefaultModels() {
  return {
    freeDrafter: getEnv('OPENROUTER_FREE_DRAFTER_MODEL') || 'openrouter/free',
    freeCritic: getEnv('OPENROUTER_FREE_CRITIC_MODEL') || 'openrouter/free',
    codexCritic: getEnv('SPEC_CODEX_MODEL') || 'openai/codex-mini-latest',
    sonnet: getEnv('ANTHROPIC_MODEL_SONNET') || 'claude-sonnet-4-5',
    opus: getEnv('ANTHROPIC_MODEL_OPUS') || 'claude-opus-4-1',
  };
}

export function hasEnv(name: string): boolean {
  return Boolean(getEnv(name));
}

export function canUseGemini(): boolean {
  return hasEnv('GEMINI_API_KEY') || isTrue(getEnv('GEMINI_USE_CLI'));
}

export function canUseKimi(): boolean {
  return hasEnv('KIMI_API_KEY') || isTrue(getEnv('KIMI_USE_CLI'));
}

export function canUseOpenRouter(): boolean {
  return hasEnv('OPENROUTER_API_KEY') || hasEnv('OPENROUTER_AUTH_TOKEN');
}
