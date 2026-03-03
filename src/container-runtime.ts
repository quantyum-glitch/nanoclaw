/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

function printRuntimeFailure(helpLines: string[]): void {
  console.error('');
  console.error(
    '==============================================================',
  );
  console.error('FATAL: Container runtime failed to start');
  console.error('');
  console.error('Agents cannot run without a Linux container runtime.');
  console.error(
    'Note: NANOCLAW_USE_SQLITE_SHIM=1 only changes SQLite backend and does NOT disable containers.',
  );
  console.error('');
  for (const line of helpLines) {
    console.error(line);
  }
  console.error(
    '==============================================================',
  );
  console.error('');
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch (err) {
    logger.error({ err }, 'Container runtime CLI not found');

    const extra =
      process.platform === 'win32'
        ? [
            '5. On Windows, prefer WSL2 + Docker Desktop with WSL integration enabled.',
          ]
        : [];

    printRuntimeFailure([
      `1. Install Docker Desktop or ensure "${CONTAINER_RUNTIME_BIN}" is on PATH.`,
      `2. Open a new terminal and run: ${CONTAINER_RUNTIME_BIN} --version`,
      `3. If installed, verify PATH includes Docker CLI location.`,
      '4. Restart NanoClaw after docker is discoverable.',
      ...extra,
    ]);

    throw new Error(
      'Container runtime CLI is missing (docker command not found).',
    );
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');

    const extra =
      process.platform === 'win32'
        ? [
            '5. If using WSL2, enable Docker Desktop WSL integration for your distro.',
          ]
        : [];

    printRuntimeFailure([
      '1. Start Docker Desktop/service.',
      `2. Verify runtime health: ${CONTAINER_RUNTIME_BIN} info`,
      '3. If command fails, fix Docker daemon startup first.',
      '4. Restart NanoClaw after docker info succeeds.',
      ...extra,
    ]);

    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
