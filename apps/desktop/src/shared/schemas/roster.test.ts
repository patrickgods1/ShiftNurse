import { ROSTER_COLUMNS } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { rosterSchemas } from './roster.js';

describe('an imported roster arriving over IPC', () => {
  const opts = { columns: ROSTER_COLUMNS, reactivate: false };
  const row = (fte: number) => ({
    nurse: {
      employeeId: 'E1',
      firstName: 'Ana',
      lastName: 'Diaz',
      role: 'RN',
      employmentType: 'full_time',
      fte,
      contractedHoursPerPeriod: 72,
      seniorityDate: '2020-01-06',
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      scheduleKind: 'va_72_80',
      scheduledDaysPerWeek: 3,
    },
    credentials: [{ code: 'ACLS', expiresOn: undefined }],
  });

  it('accepts a VA 72/80 nurse with scheduled days, as the parser reads them', () => {
    const options = { columns: ROSTER_COLUMNS, reactivate: false };
    expect(rosterSchemas.importRows.safeParse(['u', [row(0.9)], options]).success).toBe(true);
  });

  it('refuses a column name the parser does not know', () => {
    const options = { columns: ['salary'], reactivate: false };
    expect(rosterSchemas.importRows.safeParse(['u', [row(0.9)], options]).success).toBe(false);
  });

  it('refuses an imported nurse at 40 FTE, as the nurse form does', () => {
    expect(rosterSchemas.importRows.safeParse(['u', [row(40)], opts]).success).toBe(false);
    expect(rosterSchemas.importRows.safeParse(['u', [row(0.9)], opts]).success).toBe(true);
  });

  it('refuses a nurse with a field the sheet does not have', () => {
    const bad = row(0.9);
    (bad.nurse as Record<string, unknown>).bogus = 1;
    expect(rosterSchemas.importRows.safeParse(['u', [bad], opts]).success).toBe(false);
  });
});
