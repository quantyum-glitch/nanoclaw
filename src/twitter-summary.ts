import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

import {
  TWITTER_SUMMARY_FILE,
  TWITTER_SUMMARY_REFRESH_COMMAND,
  TWITTER_SUMMARY_REFRESH_TIMEOUT_MS,
} from './config.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface TwitterSummaryOptions {
  summaryFile?: string;
  refreshCommand?: string;
  timeoutMs?: number;
}

function formatFreshness(msAge: number): string {
  const minutes = Math.floor(msAge / 60_000);
  if (minutes < 1) return 'freshness: just updated';
  if (minutes < 60) return `freshness: ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `freshness: ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `freshness: ${days}d ago`;
}

function missingSummaryMessage(summaryFile: string): string {
  return [
    'Twitter summary is not available yet.',
    `Expected file: ${summaryFile}`,
    'Set TWITTER_SUMMARY_FILE to your summary.txt path.',
    'Then use /twitter-summary or /twitter-now.',
  ].join('\n');
}

export function getTwitterSummary(options?: TwitterSummaryOptions): string {
  const summaryFile = options?.summaryFile || TWITTER_SUMMARY_FILE;
  if (!summaryFile || !fs.existsSync(summaryFile)) {
    return missingSummaryMessage(summaryFile || '(not configured)');
  }

  try {
    const stat = fs.statSync(summaryFile);
    const summary = fs.readFileSync(summaryFile, 'utf-8').trim();
    if (!summary) return missingSummaryMessage(summaryFile);
    const freshness = formatFreshness(Date.now() - stat.mtimeMs);
    return `${summary}\n\n[${freshness}]`;
  } catch (err) {
    logger.warn({ err, summaryFile }, 'Failed to read Twitter summary file');
    return `Failed to read Twitter summary from ${summaryFile}`;
  }
}

export async function refreshTwitterSummary(
  options?: TwitterSummaryOptions,
): Promise<string> {
  const refreshCommand =
    options?.refreshCommand ?? TWITTER_SUMMARY_REFRESH_COMMAND;
  const timeoutMs = options?.timeoutMs ?? TWITTER_SUMMARY_REFRESH_TIMEOUT_MS;

  if (!refreshCommand) {
    const summary = getTwitterSummary(options);
    return `${summary}\n\nNo refresh command configured (TWITTER_SUMMARY_REFRESH_COMMAND).`;
  }

  try {
    await execAsync(refreshCommand, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    logger.warn(
      { err, refreshCommand },
      'Twitter refresh command failed; returning cached summary',
    );
    const summary = getTwitterSummary(options);
    return `${summary}\n\nRefresh failed; returned cached summary.`;
  }

  return getTwitterSummary(options);
}
