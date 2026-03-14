import path from 'node:path';
import process from 'node:process';

import { writeArtifacts } from './lib/artifacts.js';
import { loadEnvFileIntoProcess } from './lib/env-file.js';
import {
  DebateMode,
  EXIT_CODES,
  PipelineEvent,
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
  repeat: number;
  enableGemini: boolean;
  enableKimi: boolean;
  freeTierOnly: boolean;
  freeModel?: string;
  streamJsonEvents: boolean;
}

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  node scripts/debate.ts --goal "<text>" [options]',
      '',
      'Options:',
      '  --mode <free|free+low|debate>         Mode (default: free)',
      '  --repeat <1..10>                      Repeat rounds (default: 1)',
      '  --tier-limit <1|2|3>                  Max tier (default: 2)',
      '  --allow-tier-3                        Allow high-cost high tier in debate mode',
      '  --with-gemini | --no-gemini           Enable/disable Gemini provider (default: enabled)',
      '  --with-kimi | --no-kimi               Enable/disable Kimi provider (default: enabled)',
      '  --free-tier-only                      Force free route only (disables low/high tiers)',
      '  --free-model <model-id>               Override free OpenRouter drafter model',
      '  --output-dir <path>                   Artifact root (default: ./specs)',
      '  --stream-json-events                  Emit step events as JSON lines (SSE bridge friendly)',
      '  --help                                Show help',
      '',
      'Exit codes:',
      `  ${EXIT_CODES.success}  success`,
      `  ${EXIT_CODES.failedBlocker}  FAILED_BLOCKER`,
      `  ${EXIT_CODES.escalationRequired}  ESCALATION_REQUIRED/NO_HIGH_TIER`,
      `  ${EXIT_CODES.failedExpensive}  FAILED_EXPENSIVE`,
      `  ${EXIT_CODES.providerConfig}  provider/config error`,
    ].join('\n'),
  );
}

function parseMode(raw: string | undefined): DebateMode {
  if (!raw) return 'free';
  const mode = raw.toLowerCase();
  if (mode === 'free' || mode === 'free+low' || mode === 'debate') return mode;
  throw new Error(`Invalid --mode value: ${raw}`);
}

function parseTierLimit(raw: string | undefined): 1 | 2 | 3 {
  if (!raw) return 2;
  const value = Number.parseInt(raw, 10);
  if (value === 1 || value === 2 || value === 3) return value;
  throw new Error(`Invalid --tier-limit value: ${raw}`);
}

function parseRepeat(raw: string | undefined): number {
  if (!raw) return 1;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error(`Invalid --repeat value: ${raw}. Expected 1..10.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliArgs {
  let goal = '';
  let modeRaw: string | undefined;
  let tierLimitRaw: string | undefined;
  let outputDir = './specs';
  let allowTier3 = false;
  let repeatRaw: string | undefined;
  let enableGemini = true;
  let enableKimi = true;
  let freeTierOnly = false;
  let freeModel: string | undefined;
  let streamJsonEvents = false;

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
    if (arg === '--with-gemini' || arg === '+gemini') {
      enableGemini = true;
      continue;
    }
    if (arg === '--no-gemini' || arg === '-gemini') {
      enableGemini = false;
      continue;
    }
    if (arg === '--with-kimi' || arg === '+kimi') {
      enableKimi = true;
      continue;
    }
    if (arg === '--no-kimi' || arg === '-kimi') {
      enableKimi = false;
      continue;
    }
    if (arg === '--free-tier-only') {
      freeTierOnly = true;
      continue;
    }
    if (arg === '--stream-json-events') {
      streamJsonEvents = true;
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
      case '--repeat':
        repeatRaw = next;
        i += 1;
        break;
      case '--free-model':
        freeModel = next.trim();
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!goal) throw new Error('Missing required --goal "<text>"');
  if (freeTierOnly) {
    enableGemini = false;
    enableKimi = false;
    allowTier3 = false;
  }
  return {
    goal,
    mode: parseMode(modeRaw),
    tierLimit: parseTierLimit(tierLimitRaw),
    allowTier3,
    outputDir,
    repeat: parseRepeat(repeatRaw),
    enableGemini,
    enableKimi,
    freeTierOnly,
    freeModel,
    streamJsonEvents,
  };
}

function printSummary(
  status: PipelineStatus,
  outputDir: string,
  specPath: string,
  tracePath: string,
): void {
  console.log('\nRun complete');
  console.log(`  Status: ${status}`);
  console.log(`  Output: ${path.resolve(outputDir)}`);
  console.log(`  Spec:   ${specPath}`);
  console.log(`  Trace:  ${tracePath}`);
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
    'SPEC_FREE_PROMPT_DAILY_LIMIT',
    'SPEC_GEMINI_FREE_CRITIC_MODEL',
    'SPEC_GEMINI_LOW_CRITIC_MODEL',
    'SPEC_KIMI_LOW_CRITIC_MODEL',
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

function printEventAsJson(event: PipelineEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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

  if (args.freeModel) {
    process.env.OPENROUTER_FREE_DRAFTER_MODEL = args.freeModel;
    process.env.OPENROUTER_FREE_CRITIC_MODEL =
      process.env.OPENROUTER_FREE_CRITIC_MODEL || args.freeModel;
  }

  const pipelineInput: PipelineInput = {
    goal: args.goal,
    mode: args.mode,
    tierLimit: args.tierLimit,
    allowTier3: args.allowTier3,
    repeat: args.repeat,
    enableGemini: args.enableGemini,
    enableKimi: args.enableKimi,
    freeTierOnly: args.freeTierOnly,
    onEvent: args.streamJsonEvents ? printEventAsJson : undefined,
  };

  console.log(
    `Starting debate run (mode=${args.mode}, tierLimit=${args.tierLimit}, repeat=${args.repeat})`,
  );

  const result = await runPipeline(pipelineInput);
  const artifacts = writeArtifacts({
    outputDir: args.outputDir,
    goal: args.goal,
    status: result.status,
    spec: result.spec,
    postImplementationReview: result.postImplementationReview,
    decision: result.decision,
    trace: result.trace,
  });

  printSummary(result.status, artifacts.dir, artifacts.specPath, artifacts.tracePath);
  printSpecToTerminal(result.spec, result.postImplementationReview);
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT_CODES.providerConfig);
});
