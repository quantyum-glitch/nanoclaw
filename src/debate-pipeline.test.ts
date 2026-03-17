import { describe, expect, it } from 'vitest';

import {
  EXIT_CODES,
  PIPELINE_TEST_ONLY,
  PipelineInput,
  runPipeline,
} from '../scripts/lib/pipeline.js';
import {
  detectReviewMetadataMarkers,
  stripReviewMetadataSections,
  structuralRubric,
} from '../scripts/lib/rubric.js';

function makeInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    goal: 'test goal',
    mode: 'free',
    tierLimit: 2,
    allowTier3: false,
    repeat: 1,
    enableGemini: true,
    enableKimi: true,
    freeTierOnly: false,
    ...overrides,
  };
}

describe('debate pipeline quota estimators', () => {
  it('estimates 2 free calls baseline for free mode', () => {
    const estimated = PIPELINE_TEST_ONLY.estimateFreeCallsForRound(
      makeInput({ mode: 'free' }),
      {
        allowOpenRouter: true,
        allowGemini: true,
        allowKimi: true,
        freeTierOnly: false,
      },
      false,
    );
    expect(estimated).toBe(2);
  });

  it('adds conservative fallback increment when low tiers are unavailable', () => {
    const estimated = PIPELINE_TEST_ONLY.estimateFreeCallsForRound(
      makeInput({ mode: 'debate' }),
      {
        allowOpenRouter: true,
        allowGemini: false,
        allowKimi: false,
        freeTierOnly: false,
      },
      false,
    );
    expect(estimated).toBe(3);
  });

  it('returns 0 in resume mode', () => {
    const estimated = PIPELINE_TEST_ONLY.estimateFreeCallsForRound(
      makeInput({ mode: 'debate' }),
      {
        allowOpenRouter: true,
        allowGemini: true,
        allowKimi: true,
        freeTierOnly: false,
      },
      true,
    );
    expect(estimated).toBe(0);
  });

  it('estimates fast-mode free usage based on selected A/B agents', () => {
    const estimated = PIPELINE_TEST_ONLY.estimateFreeCallsForRound(
      makeInput({
        mode: 'fast',
        fastDrafter: 'free',
        fastCritic: 'free',
      }),
      {
        allowOpenRouter: true,
        allowGemini: true,
        allowKimi: true,
        freeTierOnly: false,
      },
      false,
    );
    expect(estimated).toBe(3);
  });

  it('estimates zero free calls in fast mode when A/B are paid routes', () => {
    const estimated = PIPELINE_TEST_ONLY.estimateFreeCallsForRound(
      makeInput({
        mode: 'fast',
        fastDrafter: 'gemini',
        fastCritic: 'kimi',
      }),
      {
        allowOpenRouter: true,
        allowGemini: true,
        allowKimi: true,
        freeTierOnly: false,
      },
      false,
    );
    expect(estimated).toBe(0);
  });
});

describe('debate pipeline free call counting', () => {
  it('counts only openrouter:*:free keys', () => {
    const counted = PIPELINE_TEST_ONLY.countFreeCalls({
      'openrouter:qwen/qwen3-next-80b-a3b-instruct:free': 2,
      'openrouter:google/gemini-2.0-flash-exp:free': 1,
      'gemini:gemini-2.0-flash-lite-free-exp': 5,
      'kimi:moonshot-v1-8k': 4,
      'openrouter:openai/codex-mini-latest': 3,
    });
    expect(counted).toBe(3);
  });
});

describe('debate pipeline rewrite prompt ordering', () => {
  it('places critique feedback before current spec', () => {
    const prompt = PIPELINE_TEST_ONLY.buildRewritePrompt(
      'my-goal',
      'my-notes',
      'SPEC_BODY',
      'CRITIQUE_BODY',
      'low',
      'memory',
    );

    const critiqueIdx = prompt.indexOf('Critique feedback:');
    const currentSpecIdx = prompt.indexOf('Current spec:');
    expect(critiqueIdx).toBeGreaterThan(-1);
    expect(currentSpecIdx).toBeGreaterThan(-1);
    expect(critiqueIdx).toBeLessThan(currentSpecIdx);
  });
});

describe('debate pipeline goal normalization helpers', () => {
  it('clamps summary over word and char budget', () => {
    const oversized = Array.from({ length: 700 }, (_, i) => `word${i}`).join(
      ' ',
    );
    const clamped = PIPELINE_TEST_ONLY.clampGoalSummary(oversized);
    expect(clamped.truncatedAfterSummary).toBe(true);
    expect(clamped.text.length).toBeLessThanOrEqual(3000);
    expect(
      clamped.text.split(/\s+/).filter(Boolean).length,
    ).toBeLessThanOrEqual(500);
  });
});

describe('debate pipeline contamination guards', () => {
  it('strips critic marker sections but preserves inline MVP/Pareto prose', () => {
    const contaminated = [
      '## Summary',
      'Keep MVP approach and Pareto-optimal tradeoffs in the architecture.',
      '',
      'AGREEMENTS:',
      '- good',
      'DISAGREEMENTS:',
      '- bad',
      '## Architecture',
      'Real architecture content.',
      '',
      'VERDICT: BLOCKING',
      '- tail',
      '## Risks',
      'None.',
    ].join('\n');

    const stripped = stripReviewMetadataSections(contaminated);
    expect(stripped.removedMarkers.length).toBeGreaterThan(0);
    expect(stripped.text).toContain('MVP approach');
    expect(stripped.text).toContain('Pareto-optimal');
    expect(stripped.text).not.toContain('AGREEMENTS:');
    expect(stripped.text).not.toContain('VERDICT: BLOCKING');
  });

  it('structural rubric flags review metadata markers', () => {
    const contaminated = [
      '## Summary',
      'A',
      '## Architecture',
      'B',
      '## Test Plan',
      'C',
      '## Risks',
      'D',
      'HOLES:',
      '- leaked',
    ].join('\n');
    const result = structuralRubric(contaminated);
    expect(result.containsReviewMetadata).toBe(true);
    expect(result.reviewMetadataMarkers).toContain('HOLES:');
    expect(result.passed).toBe(false);
  });

  it('detectReviewMetadataMarkers only matches header-style markers', () => {
    const clean = [
      '## Summary',
      'MVP approach should minimize cost.',
      'Pareto-optimal tradeoff is acceptable.',
      '## Architecture',
      'No marker headers.',
    ].join('\n');
    const markers = detectReviewMetadataMarkers(clean);
    expect(markers).toHaveLength(0);
  });
});

describe('debate pipeline exit-code mapping', () => {
  it('returns stopped exit code when aborted before run', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runPipeline(
      makeInput({
        abortSignal: ac.signal,
      }),
    );
    expect(result.status).toBe('STOPPED');
    expect(result.exitCode).toBe(EXIT_CODES.stopped);
  });

  it('returns dedicated quota exit code for QUOTA_EXHAUSTED', async () => {
    const previousKey = process.env.OPENROUTER_API_KEY;
    const previousLimit = process.env.SPEC_FREE_PROMPT_DAILY_LIMIT;
    process.env.OPENROUTER_API_KEY = 'dummy';
    process.env.SPEC_FREE_PROMPT_DAILY_LIMIT = '0';

    try {
      const result = await runPipeline(
        makeInput({
          mode: 'free',
          repeat: 2,
        }),
      );
      expect(result.status).toBe('QUOTA_EXHAUSTED');
      expect(result.exitCode).toBe(EXIT_CODES.quotaExhausted);
    } finally {
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
      if (previousLimit === undefined)
        delete process.env.SPEC_FREE_PROMPT_DAILY_LIMIT;
      else process.env.SPEC_FREE_PROMPT_DAILY_LIMIT = previousLimit;
    }
  });
});
