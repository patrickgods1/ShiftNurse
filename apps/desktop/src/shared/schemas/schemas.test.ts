/** The runtime half of the IPC contract: every method has a real schema, and they refuse. */

import { describe, expect, it } from 'vitest';
import { API_CHANNELS } from '../api.js';
import { API_SCHEMAS } from './index.js';

describe.each(Object.keys(API_CHANNELS))('%s', (resource) => {
  const methods = API_CHANNELS[resource as keyof typeof API_CHANNELS] as readonly string[];
  const schemas = API_SCHEMAS[resource as keyof typeof API_SCHEMAS] as Record<string, unknown>;

  it('checks the arguments of every method it offers', () => {
    expect(methods.filter((m) => schemas[m] === undefined)).toEqual([]);
  });

  // zod builds an object's shape on first use, so a malformed schema (a field that is not a
  // schema) compiles and passes every test that never parses through it. Parse each once.
  it('builds every schema without throwing', () => {
    for (const method of methods) {
      const schema = schemas[method] as { safeParse(value: unknown): unknown };
      expect(() => schema.safeParse([{}, {}, {}]), `${resource}.${method}`).not.toThrow();
    }
  });
});

describe('a pay-rate edit arriving over IPC', () => {
  const update = API_SCHEMAS.cost.updatePayRate;

  it('accepts a corrected rate', () => {
    expect(update.safeParse(['rate-1', { hourlyRate: 52.5 }]).success).toBe(true);
  });

  it('refuses a rate that is not a number of dollars', () => {
    expect(update.safeParse(['rate-1', { hourlyRate: Number.NaN }]).success).toBe(false);
    expect(update.safeParse(['rate-1', { hourlyRate: -1 }]).success).toBe(false);
    expect(update.safeParse(['rate-1', { hourlyRate: '52' }]).success).toBe(false);
  });

  it('refuses a date that does not exist', () => {
    expect(update.safeParse(['rate-1', { effectiveFrom: '2026-02-30' }]).success).toBe(false);
  });

  it('refuses a field the edit may not change, rather than dropping it', () => {
    expect(update.safeParse(['rate-1', { nurseId: 'n-2' }]).success).toBe(false);
  });

  it('refuses a missing id and a stray extra argument', () => {
    expect(update.safeParse([{ hourlyRate: 50 }]).success).toBe(false);
    expect(update.safeParse(['rate-1', {}, 'extra']).success).toBe(false);
  });
});
