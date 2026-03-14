import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition } from './state-machine.js';

describe('mesh state machine', () => {
  it('allows a valid transition', () => {
    expect(canTransition('queued', 'drafting')).toBe(true);
    expect(() => assertTransition('ready_for_approval', 'approved')).not.toThrow();
  });

  it('rejects an invalid transition', () => {
    expect(canTransition('queued', 'done')).toBe(false);
    expect(() => assertTransition('queued', 'done')).toThrow(
      /Invalid mesh state transition/,
    );
  });
});

