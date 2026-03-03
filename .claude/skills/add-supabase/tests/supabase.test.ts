import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('add-supabase skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: supabase');
    expect(content).toContain('SUPABASE_PROJECT_REF');
    expect(content).toContain('SUPABASE_ACCESS_TOKEN');
  });

  it('includes supabase MCP wiring', () => {
    const file = path.join(
      skillDir,
      'modify',
      'container',
      'agent-runner',
      'src',
      'index.ts',
    );
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('mcp.supabase.com/mcp');
    expect(content).toContain('mcp__supabase__*');
  });
});
