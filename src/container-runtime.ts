/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

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
