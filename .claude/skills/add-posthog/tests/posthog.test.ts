import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-posthog skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: posthog');
    expect(content).toContain('POSTHOG_API_KEY');
    expect(content).toContain('POSTHOG_HOST');
  });

  it('includes posthog MCP wiring', () => {
    const file = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('mcp.posthog.com/sse');
    expect(content).toContain('mcp__posthog__*');
  });
});
