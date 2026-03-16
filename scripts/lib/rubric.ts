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

export interface CriticNarrativeSections {
  agreements: string[];
  disagreements: string[];
  holes: string[];
  styleOnly: string[];
  mvp: string[];
  pareto: string[];
}

export interface StructuralCheck {
  hasSummary: boolean;
  hasArchitectureOrApproach: boolean;
  hasTestsOrAcceptance: boolean;
  hasRisks: boolean;
  containsReviewMetadata: boolean;
  reviewMetadataMarkers: string[];
  passed: boolean;
  missing: string[];
}

export interface SanitizeResult {
  text: string;
  changed: boolean;
  warning?: string;
}

const ASSESSMENT_RE = /ASSESSMENT:\s*(CLEAN|MINOR|BLOCKING)\s*$/im;
const ASSESSMENT_LINE_RE = /ASSESSMENT:\s*([^\r\n]+)\s*$/im;
const REVIEW_MARKER_PATTERNS: RegExp[] = [
  /^ASSESSMENT:\s*.+$/i,
  /^VERDICT:\s*.+$/i,
  /^AGREEMENTS:\s*$/i,
  /^DISAGREEMENTS:\s*$/i,
  /^HOLES:\s*$/i,
  /^STYLE_ONLY:\s*$/i,
  /^MVP:\s*$/i,
  /^PARETO:\s*$/i,
  /^Reviewers reporting .*:\s*$/i,
];
const SPEC_SECTION_HEADER_RE = /^##\s+/;

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
  const reviewMetadataMarkers = detectReviewMetadataMarkers(spec);
  const containsReviewMetadata = reviewMetadataMarkers.length > 0;

  const missing: string[] = [];
  if (!hasSummary) missing.push('## Summary');
  if (!hasArchitectureOrApproach) missing.push('## Architecture or ## Approach');
  if (!hasTestsOrAcceptance) {
    missing.push('## Test Plan or ## Acceptance Criteria');
  }
  if (!hasRisks) missing.push('## Risks');
  if (containsReviewMetadata) {
    missing.push('Remove review metadata markers from spec output');
  }

  return {
    hasSummary,
    hasArchitectureOrApproach,
    hasTestsOrAcceptance,
    hasRisks,
    containsReviewMetadata,
    reviewMetadataMarkers,
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

function collectNarrativeItems(lines: string[]): string[] {
  const joinedLines = lines.reduce<string[]>((acc, rawLine) => {
    const line = rawLine.trim();
    if (!line) return acc;
    if (/^[-*]\s+/.test(line) || acc.length === 0) {
      acc.push(line);
      return acc;
    }
    acc[acc.length - 1] = `${acc[acc.length - 1]} ${line}`.trim();
    return acc;
  }, []);

  return joinedLines
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function getSectionSlice(lines: string[], heading: string): string[] {
  const headingRe = new RegExp(`^\\s*${heading}\\s*:`, 'i');
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start < 0) return [];

  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*[A-Z_ ]+\s*:/.test(line)) break;
    out.push(line);
  }
  return collectNarrativeItems(out);
}

export function parseCriticNarrative(raw: string): CriticNarrativeSections {
  const lines = raw.split(/\r?\n/);
  return {
    agreements: getSectionSlice(lines, 'AGREEMENTS'),
    disagreements: getSectionSlice(lines, 'DISAGREEMENTS'),
    holes: getSectionSlice(lines, 'HOLES'),
    styleOnly: getSectionSlice(lines, 'STYLE_ONLY'),
    mvp: getSectionSlice(lines, 'MVP'),
    pareto: getSectionSlice(lines, 'PARETO'),
  };
}

export function sanitizeOutput(raw: string): SanitizeResult {
  const text = raw.trim();
  if (!text) return { text, changed: false };

  const headerMatches = [
    text.search(/(^|\n)##\s*summary\b/i),
    text.search(/(^|\n)##\s*goal\b/i),
  ].filter((idx) => idx >= 0);

  if (headerMatches.length === 0) {
    return { text, changed: false };
  }

  const start = Math.min(...headerMatches);
  if (start <= 0) return { text, changed: false };

  const sanitized = text.slice(start).trim();
  return {
    text: sanitized,
    changed: true,
    warning: 'Stripped model preamble before first spec header.',
  };
}

export function detectReviewMetadataMarkers(raw: string): string[] {
  const markers: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of REVIEW_MARKER_PATTERNS) {
      if (pattern.test(trimmed)) {
        markers.push(trimmed);
        break;
      }
    }
  }
  return [...new Set(markers)];
}

export function stripReviewMetadataSections(raw: string): {
  text: string;
  removedMarkers: string[];
} {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  const removedMarkers: string[] = [];
  let droppingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const marker = REVIEW_MARKER_PATTERNS.find((pattern) => pattern.test(trimmed));

    if (marker) {
      droppingSection = true;
      removedMarkers.push(trimmed);
      continue;
    }

    if (droppingSection) {
      if (SPEC_SECTION_HEADER_RE.test(trimmed)) {
        droppingSection = false;
        kept.push(line);
      }
      continue;
    }

    kept.push(line);
  }

  return {
    text: kept.join('\n').trim(),
    removedMarkers: [...new Set(removedMarkers)],
  };
}
