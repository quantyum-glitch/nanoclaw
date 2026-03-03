import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-context7 skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: context7');
    expect(content).toContain('CONTEXT7_API_KEY');
  });

  it('includes context7 MCP wiring', () => {
    const file = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('@upstash/context7-mcp');
    expect(content).toContain('mcp__context7__*');
  });
});
