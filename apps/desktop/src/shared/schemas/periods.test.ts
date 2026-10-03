import { describe, expect, it } from 'vitest';
import { periodsSchemas } from './periods.js';

describe('a new schedule period arriving over IPC', () => {
  const create = periodsSchemas.create;
  const payload = {
    unitId: 'u-1',
    name: 'Nov 2026',
    startDate: '2026-11-01',
    endDate: '2026-12-12',
  };

  it('accepts a period with and without a request deadline', () => {
    expect(create.safeParse([payload]).success).toBe(true);
    expect(create.safeParse([{ ...payload, requestsCloseOn: '2026-10-15' }]).success).toBe(true);
  });

  it('refuses a start date that does not exist', () => {
    expect(create.safeParse([{ ...payload, startDate: '2026-02-30' }]).success).toBe(false);
  });

  it('refuses a field the period does not have, rather than dropping it', () => {
    expect(create.safeParse([{ ...payload, status: 'published' }]).success).toBe(false);
  });

  it('accepts clearing the deadline with null', () => {
    expect(periodsSchemas.setRequestsCloseOn.safeParse(['p-1', null]).success).toBe(true);
  });
});
