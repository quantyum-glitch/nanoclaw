import fs from 'node:fs';
import path from 'node:path';

export function loadEnvFileIntoProcess(
  keys: string[],
  filePath = path.join(process.cwd(), '.env'),
): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const wanted = new Set(keys);
  const loaded: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!wanted.has(key)) continue;
    if (process.env[key]?.trim()) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
