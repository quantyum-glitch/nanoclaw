import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-valyu skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: valyu');
    expect(content).toContain('VALYU_API_KEY');
  });

  it('updates container-runner secrets allowlist', () => {
    const file = path.join(skillDir, 'modify', 'src', 'container-runner.ts');
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('ANTHROPIC_BASE_URL');
    expect(content).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(content).toContain('VALYU_API_KEY');
  });

  it('adds Valyu MCP wiring', () => {
    const file = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('mcp.valyu.network');
    expect(content).toContain('mcp__valyu__*');
  });
});
