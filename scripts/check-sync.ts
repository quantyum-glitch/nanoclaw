import { execSync } from 'node:child_process';

function run(cmd: string): string {
  return execSync(cmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function parseOriginSha(output: string): string {
  return output.split(/\s+/)[0] || '';
}

function main() {
  const u56eHost = process.env.SYNC_U56E_HOST || 'jam@100.68.120.27';
  const u56eRepo = process.env.SYNC_U56E_REPO || '~/projects/nanoclaw';

  const localSha = run('git rev-parse HEAD');
  const originLine = run('git ls-remote origin refs/heads/main');
  const originSha = parseOriginSha(originLine);

  let u56eSha = '';
  try {
    u56eSha = run(
      `ssh -o ConnectTimeout=8 ${u56eHost} "cd ${u56eRepo} && git rev-parse HEAD"`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`U56E check failed: ${message}`);
    process.exit(2);
  }

  console.log(`local HEAD     ${short(localSha)} (${localSha})`);
  console.log(`origin/main    ${short(originSha)} (${originSha})`);
  console.log(`u56e HEAD      ${short(u56eSha)} (${u56eSha})`);

  const allMatch = localSha === originSha && localSha === u56eSha;
  if (!allMatch) {
    console.error('SYNC MISMATCH: local/origin/u56e are not at the same commit.');
    process.exit(1);
  }

  console.log('SYNC OK: local/origin/u56e are aligned.');
}

main();
