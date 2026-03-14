export type Assessment = 'CLEAN' | 'MINOR' | 'BLOCKING' | 'UNSTRUCTURED';
export type Severity = 'BLOCKING' | 'MINOR';

export interface Blocker {
  id: string;
  severity: Severity;
  description: string;
  fix: string;
}

export interface CriticParseResult {
  assessment: Assessment;
  blockers: Blocker[];
  structured: boolean;
  error?: string;
}

export interface StructuralCheck {
  hasSummary: boolean;
  hasArchitectureOrApproach: boolean;
  hasTestsOrAcceptance: boolean;
  hasRisks: boolean;
  passed: boolean;
  missing: string[];
}

const ASSESSMENT_RE = /ASSESSMENT:\s*(CLEAN|MINOR|BLOCKING)\s*$/im;
const ASSESSMENT_LINE_RE = /ASSESSMENT:\s*([^\r\n]+)\s*$/im;

function normalizeCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parsePipeRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return [];
  const cells = trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => normalizeCell(cell));
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function findHeaderIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const cells = parsePipeRow(lines[i]);
    if (cells.length < 4) continue;
    const joined = cells.join('|').toLowerCase();
    if (
      joined.includes('id') &&
      joined.includes('severity') &&
      joined.includes('description') &&
      joined.includes('fix')
    ) {
      return i;
    }
  }
  return -1;
}

function toSeverity(value: string): Severity | null {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'BLOCKING') return 'BLOCKING';
  if (normalized === 'MINOR') return 'MINOR';
  return null;
}

export function parseCriticMarkdownTable(raw: string): CriticParseResult {
  const text = raw.trim();
  if (!text) {
    return {
      assessment: 'UNSTRUCTURED',
      blockers: [],
      structured: false,
      error: 'Critic returned empty output.',
    };
  }

  const lines = text.split(/\r?\n/);
  const headerIndex = findHeaderIndex(lines);
  if (headerIndex < 0) {
    return {
      assessment: 'UNSTRUCTURED',
      blockers: [],
      structured: false,
      error: 'Missing required markdown table header.',
    };
  }

  const blockers: Blocker[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const cells = parsePipeRow(lines[i]);
    if (cells.length === 0) continue;
    if (isSeparatorRow(cells)) continue;
    if (cells.length < 4) continue;

    const id = normalizeCell(cells[0]);
    const severity = toSeverity(cells[1]);
    const description = normalizeCell(cells[2]);
    const fix = normalizeCell(cells[3]);
    if (!id || !severity || !description) continue;

    blockers.push({ id, severity, description, fix });
  }

  const explicitAssessment = text.match(ASSESSMENT_RE)?.[1]?.toUpperCase() as
    | 'CLEAN'
    | 'MINOR'
    | 'BLOCKING'
    | undefined;
  const assessmentLine = text.match(ASSESSMENT_LINE_RE)?.[1]?.trim();

  if (explicitAssessment) {
    return {
      assessment: explicitAssessment,
      blockers,
      structured: true,
    };
  }

  if (!assessmentLine) {
    return {
      assessment: 'UNSTRUCTURED',
      blockers: [],
      structured: false,
      error: 'Missing ASSESSMENT line.',
    };
  }

  const hasBlocking = blockers.some((b) => b.severity === 'BLOCKING');
  const hasMinor = blockers.some((b) => b.severity === 'MINOR');
  const derivedAssessment: Assessment = hasBlocking
    ? 'BLOCKING'
    : hasMinor
      ? 'MINOR'
      : 'CLEAN';

  return {
    assessment: derivedAssessment,
    blockers,
    structured: true,
    error: `Assessment value "${assessmentLine}" was invalid; derived ${derivedAssessment} from table.`,
  };
}

export function structuralRubric(spec: string): StructuralCheck {
  const hasSummary = /(^|\n)##\s*summary\b/i.test(spec);
  const hasArchitectureOrApproach =
    /(^|\n)##\s*architecture\b/i.test(spec) ||
    /(^|\n)##\s*approach\b/i.test(spec);
  const hasTestsOrAcceptance =
    /(^|\n)##\s*test\s*plan\b/i.test(spec) ||
    /(^|\n)##\s*acceptance\s*criteria\b/i.test(spec);
  const hasRisks = /(^|\n)##\s*risks?\b/i.test(spec);

  const missing: string[] = [];
  if (!hasSummary) missing.push('## Summary');
  if (!hasArchitectureOrApproach) missing.push('## Architecture or ## Approach');
  if (!hasTestsOrAcceptance) {
    missing.push('## Test Plan or ## Acceptance Criteria');
  }
  if (!hasRisks) missing.push('## Risks');

  return {
    hasSummary,
    hasArchitectureOrApproach,
    hasTestsOrAcceptance,
    hasRisks,
    passed: missing.length === 0,
    missing,
  };
}

export function getBlockingBlockers(blockers: Blocker[]): Blocker[] {
  return blockers.filter((b) => b.severity === 'BLOCKING');
}

export function trimApproxTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const charBudget = maxTokens * 4;
  if (text.length <= charBudget) return text.trim();
  return `${text.slice(0, charBudget).trim()}\n\n[TRUNCATED]`;
}

export function dedupeBlockers(blockers: Blocker[]): Blocker[] {
  const byKey = new Map<string, Blocker>();
  for (const blocker of blockers) {
    const key = `${blocker.id.toUpperCase()}::${blocker.description.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, blocker);
  }
  return [...byKey.values()];
}
