import path from 'node:path';
import process from 'node:process';

import { writeArtifacts } from './lib/artifacts.js';
import { loadEnvFileIntoProcess } from './lib/env-file.js';
import {
  DebateMode,
  EXIT_CODES,
  PipelineInput,
  PipelineStatus,
  runPipeline,
} from './lib/pipeline.js';

interface CliArgs {
  goal: string;
  mode: DebateMode;
  tierLimit: 1 | 2 | 3;
  allowTier3: boolean;
  outputDir: string;
  maxRounds: number;
}

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  node scripts/debate.ts --goal "<text>" [options]',
      '',
      'Options:',
      '  --mode <default|review|debate|yolo>   Mode (default: default)',
      '  --tier-limit <1|2|3>                  Max tier (default: 2)',
      '  --allow-tier-3                        Allow expensive tier after prompt',
      '  --output-dir <path>                   Artifact root (default: ./specs)',
      '  --max-rounds <1..10>                  Max review rounds (default: 2)',
      '  --help                                Show help',
      '',
      'Exit codes:',
      `  ${EXIT_CODES.success}  success`,
      `  ${EXIT_CODES.failedBlocker}  FAILED_BLOCKER`,
      `  ${EXIT_CODES.escalationRequired}  ESCALATION_REQUIRED`,
      `  ${EXIT_CODES.failedExpensive}  FAILED_EXPENSIVE`,
      `  ${EXIT_CODES.providerConfig}  provider/config error`,
    ].join('\n'),
  );
}

function parseMode(raw: string | undefined): DebateMode {
  if (!raw) return 'default';
  const mode = raw.toLowerCase();
  if (mode === 'default' || mode === 'review' || mode === 'debate' || mode === 'yolo') {
    return mode;
  }
  throw new Error(`Invalid --mode value: ${raw}`);
}

function parseTierLimit(raw: string | undefined): 1 | 2 | 3 {
  if (!raw) return 2;
  const value = Number.parseInt(raw, 10);
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Error(`Invalid --tier-limit value: ${raw}`);
}

function parseMaxRounds(raw: string | undefined): number {
  if (!raw) return 2;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error(`Invalid --max-rounds value: ${raw}. Expected 1..10.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  let goal = '';
  let modeRaw: string | undefined;
  let tierLimitRaw: string | undefined;
  let outputDir = './specs';
  let allowTier3 = false;
  let maxRoundsRaw: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--allow-tier-3') {
      allowTier3 = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) throw new Error(`Missing value for ${arg}`);
    switch (arg) {
      case '--goal':
        goal = next.trim();
        i += 1;
        break;
      case '--mode':
        modeRaw = next;
        i += 1;
        break;
      case '--tier-limit':
        tierLimitRaw = next;
        i += 1;
        break;
      case '--output-dir':
        outputDir = next;
        i += 1;
        break;
      case '--max-rounds':
        maxRoundsRaw = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!goal) throw new Error('Missing required --goal "<text>"');
  return {
    goal,
    mode: parseMode(modeRaw),
    tierLimit: parseTierLimit(tierLimitRaw),
    allowTier3,
    outputDir,
    maxRounds: parseMaxRounds(maxRoundsRaw),
  };
}

function printSummary(status: PipelineStatus, outputDir: string, specPath: string): void {
  console.log('\nRun complete');
  console.log(`  Status: ${status}`);
  console.log(`  Output: ${path.resolve(outputDir)}`);
  console.log(`  Spec:   ${specPath}`);
}

function printSpecToTerminal(spec: string, postReview: string): void {
  console.log('\n----- BEGIN GENERATED SPEC -----\n');
  console.log(spec.trim() || '_No spec content generated._');
  if (postReview.trim()) {
    console.log('\n## Post-Implementation Review\n');
    console.log(postReview.trim());
  }
  console.log('\n----- END GENERATED SPEC -----\n');
}

function loadDebateEnv(): void {
  const keys = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_AUTH_TOKEN',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_FREE_DRAFTER_MODEL',
    'OPENROUTER_FREE_CRITIC_MODEL',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'GEMINI_USE_CLI',
    'GEMINI_CLI_COMMAND',
    'GEMINI_CLI_MODEL',
    'KIMI_API_KEY',
    'KIMI_MODEL',
    'KIMI_BASE_URL',
    'KIMI_USE_CLI',
    'KIMI_CLI_COMMAND',
    'KIMI_CLI_MODEL',
    'KIMI_OPENROUTER_MODEL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL_SONNET',
    'ANTHROPIC_MODEL_OPUS',
    'SPEC_CODEX_MODEL',
    'SPEC_ARTIFACT_ROOT',
  ];
  loadEnvFileIntoProcess(keys);
}

async function main(): Promise<void> {
  loadDebateEnv();
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Argument error: ${(err as Error).message}`);
    printHelp();
    process.exit(EXIT_CODES.providerConfig);
    return;
  }

  const pipelineInput: PipelineInput = {
    goal: args.goal,
    mode: args.mode,
    tierLimit: args.tierLimit,
    allowTier3: args.allowTier3,
    maxRounds: args.maxRounds,
  };

  console.log(
    `Starting debate run (mode=${args.mode}, tierLimit=${args.tierLimit}, maxRounds=${args.maxRounds})`,
  );
  const result = await runPipeline(pipelineInput);

  const artifacts = writeArtifacts({
    outputDir: args.outputDir,
    goal: args.goal,
    status: result.status,
    spec: result.spec,
    postImplementationReview: result.postImplementationReview,
    decision: result.decision,
  });

  printSummary(result.status, artifacts.dir, artifacts.specPath);
  printSpecToTerminal(result.spec, result.postImplementationReview);
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT_CODES.providerConfig);
});
