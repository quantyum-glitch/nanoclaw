import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

type OpenRouterMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ProviderCallOptions {
  maxOutputTokens: number;
  timeoutMs: number;
  temperature?: number;
  modelOverride?: string;
}

export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderResult {
  text: string;
  model: string;
  provider: string;
  usage?: ProviderTokenUsage;
}

export type ProviderErrorKind = 'auth' | 'timeout' | 'network' | 'parse' | 'empty';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    kind: ProviderErrorKind,
    provider: string,
    message: string,
    options?: { retryable?: boolean; statusCode?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.provider = provider;
    this.retryable = options?.retryable ?? (kind !== 'auth');
    this.statusCode = options?.statusCode;
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider: string, message: string, statusCode?: number) {
    super('auth', provider, message, { retryable: false, statusCode });
    this.name = 'ProviderAuthError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: string, message: string) {
    super('timeout', provider, message, { retryable: true });
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderNetworkError extends ProviderError {
  constructor(provider: string, message: string, statusCode?: number) {
    super('network', provider, message, { retryable: true, statusCode });
    this.name = 'ProviderNetworkError';
  }
}

export class ProviderParseError extends ProviderError {
  constructor(provider: string, message: string) {
    super('parse', provider, message, { retryable: true });
    this.name = 'ProviderParseError';
  }
}

export class ProviderEmptyError extends ProviderError {
  constructor(provider: string, message: string) {
    super('empty', provider, message, { retryable: true });
    this.name = 'ProviderEmptyError';
  }
}

interface CliCapabilities {
  command: string;
  checkedAt: string;
  supportsTemperature: boolean;
  supportsPromptFile: boolean;
  supportsStdin: boolean;
  promptFileFlag?: '--prompt-file' | '--file';
}

interface CliCapabilityCache {
  gemini?: CliCapabilities;
  kimi?: CliCapabilities;
}

export interface CliCapabilitiesSnapshot {
  gemini?: CliCapabilities;
  kimi?: CliCapabilities;
}

const CLI_CAPS_TTL_MS = 24 * 60 * 60 * 1000;
const CLI_CAPS_PATH = path.resolve(process.cwd(), '.cache', 'debate-cli-caps.json');
let lastCliCapabilities: CliCapabilitiesSnapshot = {};

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function mustGetEnv(name: string): string {
  const value = getEnv(name);
  if (!value) throw new ProviderAuthError('env', `Missing required env var: ${name}`);
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

function ensureCacheDir(): void {
  fs.mkdirSync(path.dirname(CLI_CAPS_PATH), { recursive: true });
}

function readCliCapsCache(): CliCapabilityCache {
  try {
    const raw = fs.readFileSync(CLI_CAPS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CliCapabilityCache;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    return {};
  }
  return {};
}

function writeCliCapsCache(cache: CliCapabilityCache): void {
  ensureCacheDir();
  fs.writeFileSync(CLI_CAPS_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function isFreshCap(cap: CliCapabilities | undefined): boolean {
  if (!cap?.checkedAt) return false;
  const checkedAt = Date.parse(cap.checkedAt);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < CLI_CAPS_TTL_MS;
}

async function runCliCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
  stdinText?: string,
): Promise<{ stdout: string; stderr: string; code: number; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      reject(new ProviderTimeoutError(command, `CLI command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();

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
      reject(new ProviderNetworkError(command, `${command} execution failed: ${err.message}`));
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

async function detectCliCapabilities(
  key: 'gemini' | 'kimi',
  command: string,
): Promise<CliCapabilities> {
  const cache = readCliCapsCache();
  const cached = cache[key];
  if (cached && cached.command === command && isFreshCap(cached)) {
    lastCliCapabilities[key] = cached;
    return cached;
  }

  let helpText = '';
  try {
    const help = await runCliCommand(command, ['--help'], 8_000, {
      NO_COLOR: '1',
      CLICOLOR: '0',
    });
    helpText = `${help.stdout}\n${help.stderr}`.toLowerCase();
  } catch {
    helpText = '';
  }

  const supportsPromptFile = /--prompt-file\b|--file\b/.test(helpText);
  const promptFileFlag = /--prompt-file\b/.test(helpText)
    ? '--prompt-file'
    : /--file\b/.test(helpText)
      ? '--file'
      : undefined;
  const supportsTemperature = /--temperature\b/.test(helpText);
  const supportsStdin =
    /--stdin\b|from-stdin|read from stdin|standard input/.test(helpText);

  const detected: CliCapabilities = {
    command,
    checkedAt: new Date().toISOString(),
    supportsTemperature,
    supportsPromptFile,
    supportsStdin,
    promptFileFlag,
  };
  cache[key] = detected;
  lastCliCapabilities[key] = detected;
  writeCliCapsCache(cache);
  return detected;
}

export function getCliCapabilitiesSnapshot(): CliCapabilitiesSnapshot {
  return {
    gemini: lastCliCapabilities.gemini,
    kimi: lastCliCapabilities.kimi,
  };
}

function writePromptTempFile(prompt: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-prompt-'));
  const promptFile = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf-8');
  return promptFile;
}

function cleanupPromptTempFile(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
}

function classifyCliFailure(command: string, message: string): ProviderError {
  if (/timed out/i.test(message)) return new ProviderTimeoutError(command, message);
  if (/unauthorized|forbidden|invalid_auth|incorrect_api_key|not logged in|login/i.test(message)) {
    return new ProviderAuthError(command, message);
  }
  if (/empty|no content/i.test(message)) return new ProviderEmptyError(command, message);
  if (/json|parse|format/i.test(message)) return new ProviderParseError(command, message);
  return new ProviderNetworkError(command, message);
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
  return lines.join('\n').trim();
}

async function callGeminiCli(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const command = getEnv('GEMINI_CLI_COMMAND') || 'gemini';
  const cliModel = getEnv('GEMINI_CLI_MODEL');
  const caps = await detectCliCapabilities('gemini', command);

  const args: string[] = ['--output-format', 'text'];
  let promptFile: string | undefined;
  let stdinText: string | undefined;

  if (cliModel && cliModel !== 'gemini-cli') {
    args.push('-m', cliModel);
  }
  if (caps.supportsTemperature && typeof options.temperature === 'number') {
    args.push('--temperature', String(options.temperature));
  }

  if (caps.supportsPromptFile && caps.promptFileFlag) {
    promptFile = writePromptTempFile(prompt);
    args.push(caps.promptFileFlag, promptFile);
  } else if (caps.supportsStdin) {
    args.push('--stdin');
    stdinText = prompt;
  } else {
    args.push('-p', prompt);
  }

  try {
    const result = await runCliCommand(
      command,
      args,
      options.timeoutMs,
      {
        NO_COLOR: '1',
        CLICOLOR: '0',
      },
      stdinText,
    );
    const text = stripAnsi(result.stdout).trim();
    if (result.code !== 0) {
      throw classifyCliFailure(
        command,
        `Gemini CLI failed (exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''}): ${stripAnsi(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }
    if (!text) {
      throw new ProviderEmptyError(
        command,
        `Gemini CLI returned empty content: ${stripAnsi(result.stderr).slice(0, 300)}`,
      );
    }
    return {
      text,
      model: cliModel || 'gemini-cli',
      provider: 'gemini-cli',
    };
  } finally {
    cleanupPromptTempFile(promptFile);
  }
}

async function callKimiCli(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const command = getEnv('KIMI_CLI_COMMAND') || 'kimi';
  const caps = await detectCliCapabilities('kimi', command);

  const args: string[] = ['--print'];
  let promptFile: string | undefined;
  let stdinText: string | undefined;

  if (caps.supportsTemperature && typeof options.temperature === 'number') {
    args.push('--temperature', String(options.temperature));
  }
  if (caps.supportsPromptFile && caps.promptFileFlag) {
    promptFile = writePromptTempFile(prompt);
    args.push(caps.promptFileFlag, promptFile);
  } else if (caps.supportsStdin) {
    args.push('--stdin');
    stdinText = prompt;
  } else {
    args.push('-p', prompt);
  }

  try {
    const result = await runCliCommand(
      command,
      args,
      options.timeoutMs,
      {
        NO_COLOR: '1',
        CLICOLOR: '0',
      },
      stdinText,
    );
    if (result.code !== 0) {
      throw classifyCliFailure(
        command,
        `Kimi CLI failed (exit=${result.code}${result.signal ? ` signal=${result.signal}` : ''}): ${stripAnsi(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }
    const text = extractKimiCliText(result.stdout, prompt);
    if (!text) {
      throw new ProviderParseError(
        command,
        `Kimi CLI output format unrecognized (no content). Raw: ${stripAnsi(result.stdout || result.stderr).slice(0, 400)}`,
      );
    }
    if (/invalid_authentication_error|incorrect_api_key|unauthorized|login/i.test(text)) {
      throw new ProviderAuthError(command, `Kimi CLI auth error: ${text.slice(0, 300)}`);
    }
    return {
      text,
      model: getEnv('KIMI_CLI_MODEL') || 'kimi-cli',
      provider: 'kimi-cli',
    };
  } finally {
    cleanupPromptTempFile(promptFile);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  provider: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ProviderTimeoutError(provider, `Request timed out after ${timeoutMs}ms`);
    }
    throw new ProviderNetworkError(provider, (err as Error).message);
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

function extractOpenRouterUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const output =
    typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function extractGeminiUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const usage = data.usageMetadata as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const input =
    typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : undefined;
  const output =
    typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : undefined;
  const total = typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function extractAnthropicUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const usage = data.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return undefined;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;
  const total =
    input !== undefined || output !== undefined
      ? (input || 0) + (output || 0)
      : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

async function parseJsonResponse(
  response: Response,
  provider: string,
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(
        provider,
        `HTTP ${response.status} ${response.statusText}: ${body}`,
        response.status,
      );
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new ProviderNetworkError(
        provider,
        `HTTP ${response.status} ${response.statusText}: ${body}`,
        response.status,
      );
    }
    throw new ProviderParseError(
      provider,
      `HTTP ${response.status} ${response.statusText}: ${body}`,
    );
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    throw new ProviderParseError(provider, `Invalid JSON response: ${(err as Error).message}`);
  }
}

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  options: ProviderCallOptions & { model: string },
): Promise<ProviderResult> {
  const providerName = 'openrouter';
  const apiKey =
    getEnv('OPENROUTER_API_KEY') ||
    getEnv('OPENROUTER_AUTH_TOKEN') ||
    getEnv('ANTHROPIC_AUTH_TOKEN');
  if (!apiKey) {
    throw new ProviderAuthError(
      providerName,
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
    providerName,
  );
  const data = await parseJsonResponse(response, providerName);
  const text = extractOpenRouterText(data);
  if (!text) {
    throw new ProviderEmptyError(providerName, `OpenRouter model ${options.model} returned empty content`);
  }
  return {
    text,
    model: options.model,
    provider: providerName,
    usage: extractOpenRouterUsage(data),
  };
}

export async function callGemini(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const errors: string[] = [];
  const useCli = isTrue(getEnv('GEMINI_USE_CLI'));
  const apiKey = getEnv('GEMINI_API_KEY');
  const model = options.modelOverride || getEnv('GEMINI_MODEL') || 'gemini-2.0-flash';

  if (useCli) {
    try {
      return await callGeminiCli(prompt, options);
    } catch (err) {
      errors.push(`gemini-cli: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof ProviderAuthError && !apiKey) throw err;
    }
  }

  if (apiKey) {
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
        'gemini',
      );
      const data = await parseJsonResponse(response, 'gemini');
      const text = extractGeminiText(data);
      if (!text) throw new ProviderEmptyError('gemini', `Gemini model ${model} returned empty content`);
      return {
        text,
        model,
        provider: 'gemini',
        usage: extractGeminiUsage(data),
      };
    } catch (err) {
      errors.push(`gemini-api: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!useCli && isTrue(getEnv('GEMINI_USE_CLI'))) {
    try {
      return await callGeminiCli(prompt, options);
    } catch (err) {
      errors.push(`gemini-cli: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length === 0) {
    throw new ProviderAuthError('gemini', 'Missing GEMINI_API_KEY and GEMINI_USE_CLI is not enabled.');
  }
  throw new ProviderNetworkError('gemini', `Gemini request failed. ${errors.join(' | ')}`);
}

export async function callKimi(
  prompt: string,
  options: ProviderCallOptions,
): Promise<ProviderResult> {
  const apiKey = getEnv('KIMI_API_KEY');
  const model = options.modelOverride || getEnv('KIMI_MODEL') || 'moonshot-v1-8k';
  const useCli = isTrue(getEnv('KIMI_USE_CLI'));
  const configuredEndpoint = getEnv('KIMI_BASE_URL');
  const endpoints = configuredEndpoint
    ? [configuredEndpoint]
    : [
        'https://api.moonshot.ai/v1/chat/completions',
        'https://api.moonshot.cn/v1/chat/completions',
      ];

  const errors: string[] = [];
  if (useCli) {
    try {
      return await callKimiCli(prompt, options);
    } catch (err) {
      errors.push(`kimi-cli: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof ProviderAuthError && !apiKey) throw err;
    }
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
        'kimi',
      );
      const data = await parseJsonResponse(response, 'kimi');
      const text = extractOpenRouterText(data);
      if (!text) throw new ProviderEmptyError('kimi', `Kimi model ${model} returned empty content`);
      return {
        text,
        model,
        provider: 'kimi',
        usage: extractOpenRouterUsage(data),
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
        usage: fallback.usage,
      };
    } catch (err) {
      errors.push(
        `openrouter:${fallbackModel}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (errors.length === 0) {
    throw new ProviderAuthError('kimi', 'Missing KIMI_API_KEY and KIMI_USE_CLI is not enabled.');
  }
  throw new ProviderNetworkError('kimi', `Kimi request failed. ${errors.join(' | ')}`);
}

export async function callAnthropic(
  prompt: string,
  options: ProviderCallOptions & { model: string },
): Promise<ProviderResult> {
  const providerName = 'anthropic';
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
    providerName,
  );
  const data = await parseJsonResponse(response, providerName);
  const text = extractAnthropicText(data);
  if (!text) {
    throw new ProviderEmptyError(providerName, `Anthropic model ${options.model} returned empty content`);
  }
  return {
    text,
    model: options.model,
    provider: providerName,
    usage: extractAnthropicUsage(data),
  };
}

export function getDefaultModels() {
  return {
    freeDrafter:
      getEnv('OPENROUTER_FREE_DRAFTER_MODEL') || 'qwen/qwen3-next-80b-a3b-instruct:free',
    freeCritic:
      getEnv('OPENROUTER_FREE_CRITIC_MODEL') || 'google/gemini-2.0-flash-exp:free',
    geminiFreeCritic:
      getEnv('SPEC_GEMINI_FREE_CRITIC_MODEL') || 'gemini-2.0-flash',
    geminiLowCritic:
      getEnv('SPEC_GEMINI_LOW_CRITIC_MODEL') || 'gemini-2.5-pro',
    kimiLowCritic: getEnv('SPEC_KIMI_LOW_CRITIC_MODEL') || 'moonshot-v1-8k',
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
