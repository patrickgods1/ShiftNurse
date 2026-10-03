/** Tests for the key guards every repository uses on payloads that arrive over IPC. */

import { describe, expect, it } from 'vitest';
import { assertKeys } from './patch.js';

describe('assertKeys', () => {
  const allowed = ['enabled', 'limit'] as const;

  it('accepts an object that carries only the fields its type has', () => {
    expect(() =>
      assertKeys<{ enabled: boolean; limit?: number }>({ enabled: true }, allowed, 'policy'),
    ).not.toThrow();
    expect(() => assertKeys({ enabled: true, limit: 3 }, allowed, 'policy')).not.toThrow();
  });

  it('names the stray field it refuses', () => {
    expect(() => assertKeys({ enabled: true, unitId: 'x' } as never, allowed, 'policy')).toThrow(
      "A policy cannot include 'unitId'",
    );
  });
});
