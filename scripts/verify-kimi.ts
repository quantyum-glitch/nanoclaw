import process from 'node:process';

import { loadEnvFileIntoProcess } from './lib/env-file.js';

interface EndpointResult {
  endpoint: string;
  modelsStatus?: number;
  modelsError?: string;
  modelsRequestId?: string;
  chatStatus?: number;
  chatError?: string;
  chatRequestId?: string;
}

function maskKey(key: string): string {
  if (key.length < 10) return '***';
  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBodySafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseErrorMessage(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    if (parsed.error?.message && parsed.error?.type) {
      return `${parsed.error.message} (${parsed.error.type})`;
    }
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Ignore JSON parse errors and return raw text.
  }
  return body.slice(0, 200);
}

async function testEndpoint(endpointBase: string, apiKey: string): Promise<EndpointResult> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };
  const result: EndpointResult = { endpoint: endpointBase };

  const modelsResp = await fetchWithTimeout(`${endpointBase}/models`, {
    method: 'GET',
    headers,
  });
  result.modelsStatus = modelsResp.status;
  result.modelsRequestId =
    modelsResp.headers.get('msh-request-id') || modelsResp.headers.get('x-msh-request-id') || '';
  if (!modelsResp.ok) {
    result.modelsError = parseErrorMessage(await readResponseBodySafe(modelsResp));
  }

  const chatResp = await fetchWithTimeout(`${endpointBase}/chat/completions`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'reply with exactly ok' }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  result.chatStatus = chatResp.status;
  result.chatRequestId =
    chatResp.headers.get('msh-request-id') || chatResp.headers.get('x-msh-request-id') || '';
  if (!chatResp.ok) {
    result.chatError = parseErrorMessage(await readResponseBodySafe(chatResp));
  }

  return result;
}

function classify(results: EndpointResult[]): { ok: boolean; message: string } {
  const any200 = results.some(
    (r) => r.modelsStatus === 200 || r.chatStatus === 200,
  );
  if (any200) {
    return { ok: true, message: 'Kimi API key verified on at least one endpoint.' };
  }

  const all401 = results.every(
    (r) => r.modelsStatus === 401 && r.chatStatus === 401,
  );
  if (all401) {
    return {
      ok: false,
      message:
        'All endpoints returned 401 Unauthorized. This is a key/account auth problem, not NanoClaw code.',
    };
  }

  return {
    ok: false,
    message: 'Kimi endpoint checks failed (non-200 responses). See details above.',
  };
}

async function main(): Promise<void> {
  loadEnvFileIntoProcess([
    'KIMI_API_KEY',
    'KIMI_MODEL',
    'KIMI_BASE_URL',
  ]);

  const apiKey = process.env.KIMI_API_KEY?.trim();
  if (!apiKey) {
    console.error('Missing KIMI_API_KEY.');
    process.exitCode = 1;
    return;
  }

  const configuredBase = process.env.KIMI_BASE_URL?.trim();
  const defaultBases = ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'];
  const bases = Array.from(
    new Set(
      [
        configuredBase
          ? configuredBase.replace(/\/chat\/completions$/, '').replace(/\/+$/, '')
          : undefined,
        ...defaultBases,
      ].filter((value): value is string => Boolean(value)),
    ),
  );

  console.log(`Verifying Kimi key: ${maskKey(apiKey)}`);
  console.log(`Testing model: ${process.env.KIMI_MODEL || 'moonshot-v1-8k'}`);
  console.log(`Endpoints: ${bases.join(', ')}`);

  const results: EndpointResult[] = [];
  for (const base of bases) {
    try {
      const result = await testEndpoint(base, apiKey);
      results.push(result);
    } catch (err) {
      results.push({
        endpoint: base,
        modelsError: err instanceof Error ? err.message : String(err),
        chatError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const r of results) {
    console.log(`\n[${r.endpoint}]`);
    console.log(
      `  GET /models: ${r.modelsStatus ?? 'ERR'}${r.modelsError ? ` - ${r.modelsError}` : ''}${r.modelsRequestId ? ` [request_id=${r.modelsRequestId}]` : ''}`,
    );
    console.log(
      `  POST /chat/completions: ${r.chatStatus ?? 'ERR'}${r.chatError ? ` - ${r.chatError}` : ''}${r.chatRequestId ? ` [request_id=${r.chatRequestId}]` : ''}`,
    );
  }

  const verdict = classify(results);
  console.log(`\nVerdict: ${verdict.message}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`verify-kimi failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
