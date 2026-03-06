import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { getTwitterSummary } from './twitter-summary.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('getTwitterSummary', () => {
  it('returns guidance when summary file is missing', () => {
    const text = getTwitterSummary({
      summaryFile: path.join(
        os.tmpdir(),
        'nanoclaw-does-not-exist-summary.txt',
      ),
    });
    expect(text).toContain('Twitter summary is not available yet.');
    expect(text).toContain('TWITTER_SUMMARY_FILE');
  });

  it('returns summary body with freshness footer when file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-twitter-'));
    tempDirs.push(dir);
    const summaryFile = path.join(dir, 'summary.txt');
    fs.writeFileSync(summaryFile, 'Top tweet today: example post', 'utf-8');

    const text = getTwitterSummary({ summaryFile });
    expect(text).toContain('Top tweet today: example post');
    expect(text).toContain('[freshness:');
  });
});
