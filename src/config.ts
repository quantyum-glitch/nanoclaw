import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL_GENERAL',
  'OPENROUTER_MODEL_CODE',
  'OPENROUTER_FAILURE_THRESHOLD',
  'OPENROUTER_COOLDOWN_MS',
  'OPENROUTER_HISTORY_MAX_MESSAGES',
  'OPENROUTER_HISTORY_MAX_CHARS',
  'TWITTER_SUMMARY_FILE',
  'TWITTER_SUMMARY_REFRESH_COMMAND',
  'TWITTER_SUMMARY_REFRESH_TIMEOUT_MS',
]);

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  parseBoolean(
    process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER,
    false,
  );
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// OpenRouter runtime (host-side default reply path)
export const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || envConfig.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL ||
  envConfig.OPENROUTER_BASE_URL ||
  'https://openrouter.ai/api/v1';
export const OPENROUTER_MODEL_GENERAL =
  process.env.OPENROUTER_MODEL_GENERAL ||
  envConfig.OPENROUTER_MODEL_GENERAL ||
  'openrouter/free';
export const OPENROUTER_MODEL_CODE =
  process.env.OPENROUTER_MODEL_CODE ||
  envConfig.OPENROUTER_MODEL_CODE ||
  'openrouter/anthropic/claude-sonnet-4-5';
export const OPENROUTER_FAILURE_THRESHOLD = Math.max(
  1,
  parseInteger(
    process.env.OPENROUTER_FAILURE_THRESHOLD ||
      envConfig.OPENROUTER_FAILURE_THRESHOLD,
    3,
  ),
);
export const OPENROUTER_COOLDOWN_MS = Math.max(
  1_000,
  parseInteger(
    process.env.OPENROUTER_COOLDOWN_MS || envConfig.OPENROUTER_COOLDOWN_MS,
    600_000,
  ),
);
export const OPENROUTER_HISTORY_MAX_MESSAGES = Math.max(
  1,
  parseInteger(
    process.env.OPENROUTER_HISTORY_MAX_MESSAGES ||
      envConfig.OPENROUTER_HISTORY_MAX_MESSAGES,
    20,
  ),
);
export const OPENROUTER_HISTORY_MAX_CHARS = Math.max(
  200,
  parseInteger(
    process.env.OPENROUTER_HISTORY_MAX_CHARS ||
      envConfig.OPENROUTER_HISTORY_MAX_CHARS,
    6000,
  ),
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Optional host-side Twitter summary integration.
// If TWITTER_SUMMARY_FILE is missing, /twitter-summary returns guidance.
export const TWITTER_SUMMARY_FILE =
  process.env.TWITTER_SUMMARY_FILE ||
  envConfig.TWITTER_SUMMARY_FILE ||
  path.join(HOME_DIR, 'Documents', 'nanoclaw', 'data', 'twitter-list', 'summary.txt');
export const TWITTER_SUMMARY_REFRESH_COMMAND =
  process.env.TWITTER_SUMMARY_REFRESH_COMMAND ||
  envConfig.TWITTER_SUMMARY_REFRESH_COMMAND ||
  '';
export const TWITTER_SUMMARY_REFRESH_TIMEOUT_MS = Math.max(
  5_000,
  parseInteger(
    process.env.TWITTER_SUMMARY_REFRESH_TIMEOUT_MS ||
      envConfig.TWITTER_SUMMARY_REFRESH_TIMEOUT_MS,
    60_000,
  ),
);

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
