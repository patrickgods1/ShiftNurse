import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

const send = {
  periodId: 'p-1',
  date: '2026-10-05',
  shiftTypeId: 'st-d',
  role: 'RN',
  volunteers: ['n-1'],
  nurseId: 'n-1',
  toUnit: '4B Telemetry',
  reason: 'Floated to 4B Telemetry',
};

describe('float-out argument schemas', () => {
  it('accepts a float naming the shift, the role, the volunteers and the unit', () => {
    expect(API_SCHEMAS.floatOut.send.safeParse([send]).success).toBe(true);
    expect(
      API_SCHEMAS.floatOut.send.safeParse([{ ...send, objection: 'Not competent' }]).success,
    ).toBe(true);
  });

  it('refuses a float with an impossible date or an unknown role', () => {
    expect(API_SCHEMAS.floatOut.send.safeParse([{ ...send, date: '2026-02-30' }]).success).toBe(
      false,
    );
    expect(API_SCHEMAS.floatOut.send.safeParse([{ ...send, role: 'MD' }]).success).toBe(false);
  });
});
