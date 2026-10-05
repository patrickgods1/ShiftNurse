/**
 * What a manager is told about a nurse's leave while writing a request. The numbers are worked by
 * hand for a full-time nurse on three 12s a week (72 hours a 14-day pay period, so a 36-hour week
 * and 432 hours of FMLA): the warnings are advice, never a refusal.
 */

import { isoDate } from '@shiftnurse/core';
import {
  approveTimeOff,
  auditHistoryFor,
  createNurse,
  createTimeOffRequest,
  getUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { leaveBalancesApi } from './leave-balances.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
let nurseId: string;
beforeEach(() => {
  f = openFixture();
  expect(getUnit(f.handle.db, f.seeded.unitId)!.payPeriodDays).toBe(14);
  nurseId = hire('2020-01-01');
});
afterEach(() => f.handle.close());

const api = () => leaveBalancesApi(f.handle.db);

function hire(seniorityDate: string): string {
  return createNurse(
    f.handle.db,
    {
      unitId: f.seeded.unitId,
      employeeId: `LB-${seniorityDate}`,
      firstName: 'Lena',
      lastName: 'Balance',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate(seniorityDate),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
}

const check = (type: Parameters<ReturnType<typeof api>['checkRequest']>[1], hours: number) =>
  api().checkRequest(nurseId, type, isoDate('2026-10-05'), isoDate('2026-10-11'), hours);

describe('a PTO request against the balance on file', () => {
  it('says the request pays 36 hours, the balance is 20, 16 short', () => {
    api().setBalance(nurseId, 'pto', 20, isoDate('2026-10-01'));
    const result = check('pto', 36);
    expect(result.balance).toMatchObject({ type: 'pto', balanceHours: 20, asOf: '2026-10-01' });
    expect(result.balance!.check).toEqual({
      ok: false,
      shortHours: 16,
      message: 'This request pays 36 hours; the balance is 20, 16 short.',
    });
  });

  it('is fine when the balance covers it, and says what would be left', () => {
    api().setBalance(nurseId, 'pto', 40, isoDate('2026-10-01'));
    expect(check('pto', 36).balance!.check).toEqual({ ok: true, remainingHours: 4 });
  });

  it('checks a sick request against the sick balance, not PTO', () => {
    api().setBalance(nurseId, 'pto', 200, isoDate('2026-10-01'));
    api().setBalance(nurseId, 'sick', 8, isoDate('2026-10-01'));
    expect(check('sick', 12).balance).toMatchObject({ type: 'sick', balanceHours: 8 });
  });

  it('says there is no balance to check when payroll’s figure was never entered', () => {
    expect(check('pto', 36)).toEqual({ noBalanceFor: 'pto' });
  });

  it('checks no balance for unpaid leave', () => {
    expect(check('unpaid', 0)).toEqual({});
  });

  it('audits a changed balance with what it was before', () => {
    const first = api().setBalance(nurseId, 'pto', 40, isoDate('2026-10-01'));
    api().setBalance(nurseId, 'pto', 28, isoDate('2026-10-15'));
    expect(auditHistoryFor(f.handle.db, 'leave_balance', first.id)[0]).toMatchObject({
      action: 'update',
      before: { balanceHours: 40 },
      after: { balanceHours: 28 },
    });
  });
});

describe('an FMLA request', () => {
  it('uses a week of the 432 hours and says a nurse with no hours worked is not eligible', () => {
    const fmla = check('fmla', 0).fmla!;
    expect(fmla.weeklyHours).toBe(36);
    expect(fmla.requestHours).toBe(36);
    expect(fmla.remainingHours).toBe(432);
    expect(fmla.eligibility).toEqual({
      eligible: false,
      reason: 'Worked 0 hours in the last 12 months; FMLA needs 1,250.',
    });
    expect(fmla.certified).toBe(false);
  });

  it('takes two weeks already approved off what is left', () => {
    const earlier = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-08-03'),
        endDate: isoDate('2026-08-16'),
        type: 'fmla',
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, earlier.id, ACTOR);
    // 14 calendar days at 36 hours a week is 72 hours: 432 − 72.
    expect(check('fmla', 0).fmla!.remainingHours).toBe(360);
  });

  it('does not count FMLA leave that is still only asked for', () => {
    createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-08-03'),
        endDate: isoDate('2026-08-16'),
        type: 'fmla',
      },
      ACTOR,
    );
    expect(check('fmla', 0).fmla!.remainingHours).toBe(432);
  });

  it('says a nurse hired four months ago has not been employed 12', () => {
    nurseId = hire('2026-06-01');
    expect(check('fmla', 0).fmla!.eligibility).toEqual({
      eligible: false,
      reason: 'Employed 4 months; FMLA needs 12.',
    });
  });

  it('notes when a certification covers the first day', () => {
    api().addCertification({
      nurseId,
      startDate: isoDate('2026-10-01'),
      endDate: isoDate('2027-03-31'),
      intermittent: true,
    });
    expect(check('fmla', 0).fmla!.certified).toBe(true);
    expect(
      api().checkRequest(nurseId, 'fmla', isoDate('2027-04-05'), isoDate('2027-04-11'), 0).fmla!
        .certified,
    ).toBe(false);
  });
});

describe('a nurse’s leave records', () => {
  it('lists balances and certifications together, and removes a certification', () => {
    api().setBalance(nurseId, 'pto', 40, isoDate('2026-10-01'));
    const cert = api().addCertification({
      nurseId,
      startDate: isoDate('2026-10-01'),
      endDate: isoDate('2027-03-31'),
      intermittent: false,
      note: 'Dr. Lee',
    });
    const records = api().forNurse(nurseId);
    expect(records.balances.map((b) => b.type)).toEqual(['pto']);
    expect(records.certifications).toEqual([cert]);
    api().removeCertification(cert.id);
    expect(api().forNurse(nurseId).certifications).toEqual([]);
  });
});
