/** Tests for the key guards every repository uses on payloads that arrive over IPC. */

import { describe, expect, it } from 'vitest';
import { assertKeys } from './patch.js';

describe('assertKeys', () => {
  type Policy = { enabled: boolean; limit?: number };
  const allowed = { enabled: true, limit: true } as const;

  it('accepts an object that carries only the fields its type has', () => {
    expect(() => assertKeys<Policy>({ enabled: true }, allowed, 'policy')).not.toThrow();
    expect(() => assertKeys<Policy>({ enabled: true, limit: 3 }, allowed, 'policy')).not.toThrow();
  });

  it('names the stray field it refuses', () => {
    expect(() =>
      assertKeys<Policy>({ enabled: true, unitId: 'x' } as Policy, allowed, 'policy'),
    ).toThrow("A policy cannot include 'unitId'");
  });
});
