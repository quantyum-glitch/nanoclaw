import fs from 'fs';
import path from 'path';

import { formatDebateMessage, runOpenRouterDebate } from '../src/openrouter-debate.js';

function readPromptFromArgsOrStdin(args: string[]): string {
  const promptArgIdx = args.indexOf('--prompt');
  if (promptArgIdx !== -1 && args[promptArgIdx + 1]) {
    return args[promptArgIdx + 1];
  }

  const fileArgIdx = args.indexOf('--file');
  if (fileArgIdx !== -1 && args[fileArgIdx + 1]) {
    const filePath = path.resolve(process.cwd(), args[fileArgIdx + 1]);
    return fs.readFileSync(filePath, 'utf8');
  }

  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, 'utf8');
  }

  throw new Error('Provide --prompt "..." or --file path/to/prompt.txt (or pipe stdin).');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const prompt = readPromptFromArgsOrStdin(args).trim();

  if (!prompt) {
    throw new Error('Prompt is empty.');
  }

  const result = await runOpenRouterDebate(prompt);
  console.log(formatDebateMessage(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
