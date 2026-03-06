import {
  OPENROUTER_COOLDOWN_MS,
  OPENROUTER_FAILURE_THRESHOLD,
} from './config.js';
import { logger } from './logger.js';

let openRouterConsecutiveFailures = 0;
let openRouterCircuitOpenUntil = 0;

export function getOpenRouterCircuitState(): {
  failures: number;
  openUntil: number;
} {
  return {
    failures: openRouterConsecutiveFailures,
    openUntil: openRouterCircuitOpenUntil,
  };
}

export function isOpenRouterCircuitOpen(): boolean {
  return Date.now() < openRouterCircuitOpenUntil;
}

export function resetOpenRouterFailures(): void {
  openRouterConsecutiveFailures = 0;
  openRouterCircuitOpenUntil = 0;
}

export function registerOpenRouterFailure(reason: string): void {
  openRouterConsecutiveFailures += 1;
  if (openRouterConsecutiveFailures >= OPENROUTER_FAILURE_THRESHOLD) {
    openRouterCircuitOpenUntil = Date.now() + OPENROUTER_COOLDOWN_MS;
    logger.warn(
      {
        reason,
        openRouterConsecutiveFailures,
        circuitOpenUntil: new Date(openRouterCircuitOpenUntil).toISOString(),
      },
      'OpenRouter circuit opened',
    );
  }
}

/** @internal - exported for testing */
export function _resetOpenRouterCircuitForTests(): void {
  openRouterConsecutiveFailures = 0;
  openRouterCircuitOpenUntil = 0;
}

/** @internal - exported for testing */
export function _registerOpenRouterFailureForTests(reason = 'test'): void {
  registerOpenRouterFailure(reason);
}

/** @internal - exported for testing */
export function _isOpenRouterCircuitOpenForTests(nowMs?: number): boolean {
  if (typeof nowMs !== 'number') return isOpenRouterCircuitOpen();
  return nowMs < openRouterCircuitOpenUntil;
}

/** @internal - exported for testing */
export function _getOpenRouterCircuitStateForTests(): {
  failures: number;
  openUntil: number;
} {
  return getOpenRouterCircuitState();
}
