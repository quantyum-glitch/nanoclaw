import { beforeEach, describe, expect, it } from 'vitest';

import {
  OPENROUTER_FAILURE_THRESHOLD,
  OPENROUTER_COOLDOWN_MS,
} from './config.js';
import {
  _getOpenRouterCircuitStateForTests,
  _isOpenRouterCircuitOpenForTests,
  _registerOpenRouterFailureForTests,
  _resetOpenRouterCircuitForTests,
} from './index.js';

describe('openrouter circuit breaker', () => {
  beforeEach(() => {
    _resetOpenRouterCircuitForTests();
  });

  it('opens only when failure threshold is reached', () => {
    for (let i = 0; i < OPENROUTER_FAILURE_THRESHOLD - 1; i += 1) {
      _registerOpenRouterFailureForTests('timeout');
    }
    expect(_isOpenRouterCircuitOpenForTests()).toBe(false);

    _registerOpenRouterFailureForTests('timeout');

    const state = _getOpenRouterCircuitStateForTests();
    expect(state.failures).toBe(OPENROUTER_FAILURE_THRESHOLD);
    expect(state.openUntil).toBeGreaterThan(Date.now());
    expect(state.openUntil - Date.now()).toBeLessThanOrEqual(
      OPENROUTER_COOLDOWN_MS,
    );
    expect(_isOpenRouterCircuitOpenForTests()).toBe(true);
  });

  it('reset clears failures and closes the circuit', () => {
    _registerOpenRouterFailureForTests('timeout');
    _registerOpenRouterFailureForTests('timeout');
    _registerOpenRouterFailureForTests('timeout');
    expect(_isOpenRouterCircuitOpenForTests()).toBe(true);

    _resetOpenRouterCircuitForTests();
    expect(_isOpenRouterCircuitOpenForTests()).toBe(false);
    expect(_getOpenRouterCircuitStateForTests()).toEqual({
      failures: 0,
      openUntil: 0,
    });
  });
});
