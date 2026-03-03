import { formatFreeModelsMessage, listOpenRouterFreeModels } from '../src/openrouter-debate.js';

async function main(): Promise<void> {
  const models = await listOpenRouterFreeModels(30);
  console.log(formatFreeModelsMessage(models));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
