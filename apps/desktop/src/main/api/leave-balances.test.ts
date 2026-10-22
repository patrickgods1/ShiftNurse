/**
 * What a manager is told about a nurse's leave while writing a request. The numbers are worked by
 * hand for a full-time nurse on three 12s a week (72 hours a 14-day pay period, so a 36-hour week
 * and 432 hours of FMLA): the warnings are advice, never a refusal.
 *
 * The fixture unit's pay periods are 14 days from 2026-08-23, so they close on 09-05, 09-19,
 * 10-03, 10-17 and 10-31: the dates in the leave-policy cases below are counted from that.
 */

import { addDays, defaultRuleSet, type IsoDate, isoDate, type LeavePolicy } from '@shiftnurse/core';
import {
  approveTimeOff,
  auditHistoryFor,
  createAssignment,
  createNurse,
  createNurseUnit,
  createPeriod,
  createShiftType,
  createTimeOffRequest,
  createUnit,
  deactivateShiftType,
  getPeriod,
  getUnit,
  listShiftTypesForUnit,
  publishSchedule,
  recordCompTimeCredits,
  saveRuleSet,
  transact,
  updateUnit,
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

function hire(
  seniorityDate: string,
  extra: { hireDate?: string; hours?: number; scheduleKind?: 'va_72_80' } = {},
): string {
  return createNurse(
    f.handle.db,
    {
      unitId: f.seeded.unitId,
      employeeId: `LB-${seniorityDate}-${extra.hireDate ?? ''}-${extra.hours ?? ''}-${extra.scheduleKind ?? ''}`,
      firstName: 'Lena',
      lastName: 'Balance',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: extra.hours ?? 72,
      seniorityDate: isoDate(seniorityDate),
      ...(extra.hireDate ? { hireDate: isoDate(extra.hireDate) } : {}),
      ...(extra.scheduleKind ? { scheduleKind: extra.scheduleKind } : {}),
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

/** Shifts the nurse worked: a schedule of their own spanning the dates, published, since a
 *  draft's rows are only proposed. */
function workedHistory(dates: readonly IsoDate[], shiftTypeId = f.day.id): void {
  const { db } = f.handle;
  const draft = getPeriod(db, f.seeded.draftPeriodId)!;
  const history = createPeriod(
    db,
    {
      unitId: f.seeded.unitId,
      name: `Worked from ${dates[0]!}`,
      startDate: dates[0]!,
      endDate: dates.at(-1)!,
      ruleSetId: draft.ruleSetId,
      ruleSetVersion: draft.ruleSetVersion,
    },
    ACTOR,
  );
  for (const date of dates) {
    createAssignment(db, { periodId: history.id, nurseId, shiftTypeId, date }, ACTOR);
  }
  transact(db, (tx) => publishSchedule(tx, { periodId: history.id, ledger: [] }, ACTOR));
}

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
    expect(fmla).toMatchObject({
      regime: 'title1',
      entitlementHours: 432,
      basis: 'contract',
      // A unit with no policy counts the 365 days ending on the first day of leave.
      period: { from: '2025-10-06', to: '2026-10-05' },
    });
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

describe('a nurse’s comp-time elections', () => {
  const unitId = () => f.seeded.unitId;

  it('lists, edits and removes an election, each write audited with the nurse named', () => {
    const made = api().addCompElection({
      unitId: unitId(),
      nurseId,
      startsOn: isoDate('2026-10-01'),
      note: 'Signed',
    });
    expect(api().compElections(nurseId)).toMatchObject([{ id: made.id, startsOn: '2026-10-01' }]);
    const edited = api().updateCompElection(made.id, { endsOn: isoDate('2026-12-31') });
    expect(edited.endsOn).toBe('2026-12-31');
    api().removeCompElection(made.id);
    expect(api().compElections(nurseId)).toEqual([]);
    expect(
      auditHistoryFor(f.handle.db, 'comp_time_election', made.id).map((e) => e.action),
    ).toEqual(['delete', 'update', 'create']);
  });

  it('refuses an overlapping election in words and leaves nothing half-written', () => {
    api().addCompElection({ unitId: unitId(), nurseId, startsOn: isoDate('2026-10-01') });
    expect(() =>
      api().addCompElection({ unitId: unitId(), nurseId, startsOn: isoDate('2026-11-01') }),
    ).toThrow(/Lena Balance already has a comp-time election covering/);
    expect(api().compElections(nurseId)).toHaveLength(1);
  });
});

describe('comp time banked from a finished schedule', () => {
  /** Banks `hours` of comp for the nurse from a period ending on `endDate`. */
  function bank(startDate: string, endDate: string, hours: number): void {
    const { db } = f.handle;
    const draft = getPeriod(db, f.seeded.draftPeriodId)!;
    const period = createPeriod(
      db,
      {
        unitId: f.seeded.unitId,
        name: `Banked ${endDate}`,
        startDate: isoDate(startDate),
        endDate: isoDate(endDate),
        ruleSetId: draft.ruleSetId,
        ruleSetVersion: draft.ruleSetVersion,
      },
      ACTOR,
    );
    transact(db, (tx) =>
      recordCompTimeCredits(
        tx,
        period.id,
        [{ nurseId, overtimeHours: hours / 1.5, creditedHours: hours, paidOvertimeHours: 0 }],
        ACTOR,
      ),
    );
  }

  it('raises a comp request’s 10-hour balance to 16 with 6 hours banked since payroll’s date', () => {
    api().setBalance(nurseId, 'comp', 10, isoDate('2026-09-01'));
    bank('2026-09-06', '2026-09-19', 6);
    expect(check('comp', 12).balance).toMatchObject({
      balanceHours: 10,
      earnedHours: 6,
      projectedHours: 16,
      check: { ok: true, remainingHours: 4 },
    });
  });

  it('counts a credit from the day after its schedule ends, not on the last day itself', () => {
    api().setBalance(nurseId, 'comp', 10, isoDate('2026-09-01'));
    bank('2026-09-22', '2026-10-05', 6);
    // The request starts 10-05, the banked schedule's last day.
    expect(check('comp', 12).balance).toMatchObject({ earnedHours: 0, projectedHours: 10 });
  });

  it('leaves a credit payroll had already counted on its date out of the projection', () => {
    bank('2026-09-06', '2026-09-19', 6);
    api().setBalance(nurseId, 'comp', 16, isoDate('2026-09-20'));
    expect(check('comp', 12).balance).toMatchObject({ earnedHours: 0, projectedHours: 16 });
  });

  it('banks nothing into a PTO balance', () => {
    api().setBalance(nurseId, 'pto', 10, isoDate('2026-09-01'));
    bank('2026-09-06', '2026-09-19', 6);
    expect(check('pto', 12).balance).toMatchObject({ earnedHours: 0, projectedHours: 10 });
  });
});

const VA_POLICY: LeavePolicy = {
  fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
  leaveYearStart: 'first_full_pay_period',
  accrual: [
    {
      balanceType: 'annual',
      roles: ['RN'],
      employmentTypes: ['full_time'],
      tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 8 }],
      carryoverCapHours: 685,
    },
  ],
};

const setPolicy = (policy: LeavePolicy | null) =>
  updateUnit(f.handle.db, f.seeded.unitId, { leavePolicy: policy }, ACTOR);

describe('leave under a VA unit’s policy', () => {
  beforeEach(() => {
    expect(getUnit(f.handle.db, f.seeded.unitId)!.payPeriodAnchor).toBe('2026-08-23');
    setPolicy(VA_POLICY);
  });

  it('gives an 80-hour-a-pay-period nurse 480 hours of Title 5 FMLA, counted forward from first use', () => {
    nurseId = hire('2020-01-01', { hours: 80 });
    const fmla = check('fmla', 0).fmla!;
    expect(fmla).toMatchObject({
      regime: 'title5',
      weeklyHours: 40,
      entitlementHours: 480,
      basis: 'title5_tour',
      remainingHours: 480,
      period: { from: '2026-10-05', to: '2027-10-04' },
    });
    // No 1,250-hour test under Title 5: a nurse with no worked hours on record is eligible.
    expect(fmla.eligibility).toEqual({ eligible: true });
  });

  it('projects a full-time RN’s 100 hours of annual leave three closed pay periods on to 124', () => {
    nurseId = hire('2020-01-01', { hours: 80 });
    api().setBalance(nurseId, 'annual', 100, isoDate('2026-09-06'));
    // Periods ending 09-19, 10-03 and 10-17 close before the request starts on 10-19: 3 × 8 h.
    const result = api().checkRequest(
      nurseId,
      'annual',
      isoDate('2026-10-19'),
      isoDate('2026-10-25'),
      40,
    );
    expect(result.balance).toMatchObject({
      type: 'annual',
      balanceHours: 100,
      asOf: '2026-09-06',
      projectedHours: 124,
      accruedHours: 24,
      usedHours: 0,
      forfeitedHours: 0,
    });
    expect(result.balance!.check).toEqual({ ok: true, remainingHours: 84 });
  });

  it('takes annual leave already approved since payroll’s figure off the projection', () => {
    nurseId = hire('2020-01-01', { hours: 80 });
    api().setBalance(nurseId, 'annual', 100, isoDate('2026-09-06'));
    const earlier = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-10-10'),
        endDate: isoDate('2026-10-10'),
        type: 'annual',
        paidHours: 12,
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, earlier.id, ACTOR);
    const result = api().checkRequest(
      nurseId,
      'annual',
      isoDate('2026-10-19'),
      isoDate('2026-10-25'),
      40,
    );
    // 100 + 24 accrued − 12 approved.
    expect(result.balance).toMatchObject({ projectedHours: 112, accruedHours: 24, usedHours: 12 });
  });

  it('accrues nothing for a nurse no rule covers, and says so by leaving the balance alone', () => {
    nurseId = hire('2020-01-01', { hours: 80 });
    api().setBalance(nurseId, 'sick', 20, isoDate('2026-09-06'));
    const result = api().checkRequest(
      nurseId,
      'sick',
      isoDate('2026-10-19'),
      isoDate('2026-10-19'),
      12,
    );
    expect(result.balance).toMatchObject({ projectedHours: 20, accruedHours: 0 });
  });
});

describe('Title I FMLA eligibility', () => {
  it('says a nurse hired 11 months ago is not eligible, whatever their seniority', () => {
    // Seniority five years back, hire date 2025-11-01: on 2026-10-05 that is 11 whole months.
    nurseId = hire('2021-10-05', { hireDate: '2025-11-01' });
    expect(check('fmla', 0).fmla!.eligibility).toEqual({
      eligible: false,
      reason: 'Employed 11 months; FMLA needs 12.',
    });
  });

  it('uses the average week of the last year only when the record reaches back all 52 weeks', () => {
    // 26 twelve-hour shifts a fortnight apart, the first on the day 364 days before the request.
    const start = isoDate('2026-10-05');
    const shifts = (from: number) =>
      Array.from({ length: 26 - from }, (_, k) => addDays(start, -364 + 14 * (from + k)));
    workedHistory(shifts(1));
    // The record starts 350 days back: too short to call 312 hours the year's average.
    expect(check('fmla', 0).fmla).toMatchObject({ entitlementHours: 432, basis: 'contract' });
    workedHistory(shifts(0).slice(0, 1));
    // 26 × 12 = 312 hours over 52 weeks is 6 a week; 12 weeks of it is 72.
    expect(check('fmla', 0).fmla).toMatchObject({ entitlementHours: 72, basis: 'average' });
  });

  it('counts a night the nurse floated to 5 West toward the 1,250 hours', () => {
    const { db } = f.handle;
    const west = createUnit(
      db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const n12 = createShiftType(
      db,
      {
        unitId: west.id,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#000',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    // 100 days before the request's first day, 2026-10-05.
    const floated = isoDate('2026-06-27');
    createNurseUnit(
      db,
      {
        nurseId,
        unitId: west.id,
        startDate: isoDate('2026-06-01'),
        endDate: isoDate('2026-07-31'),
      },
      ACTOR,
    );
    const rules = transact(db, (tx) => saveRuleSet(tx, defaultRuleSet(west.id), ACTOR));
    const period = createPeriod(
      db,
      {
        unitId: west.id,
        name: '5 West late June',
        startDate: isoDate('2026-06-21'),
        endDate: isoDate('2026-07-04'),
        ruleSetId: rules.id,
        ruleSetVersion: rules.version,
      },
      ACTOR,
    );
    createAssignment(
      db,
      { periodId: period.id, nurseId, shiftTypeId: n12.id, date: floated },
      ACTOR,
    );
    transact(db, (tx) => publishSchedule(tx, { periodId: period.id, ledger: [] }, ACTOR));
    // One 12-hour shift; it used to count 0 because only 4 West's shift types were priced.
    expect(check('fmla', 0).fmla!.eligibility).toEqual({
      eligible: false,
      reason: 'Worked 12 hours in the last 12 months; FMLA needs 1,250.',
    });
  });

  it('does not count shifts proposed on a draft as hours worked', () => {
    const draft = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    expect(draft.status).toBe('draft');
    const proposed = draft.startDate;
    expect(proposed < '2026-10-05').toBe(true);
    createAssignment(
      f.handle.db,
      { periodId: draft.id, nurseId, shiftTypeId: f.day.id, date: proposed },
      ACTOR,
    );
    expect(check('fmla', 0).fmla!.eligibility).toEqual({
      eligible: false,
      reason: 'Worked 0 hours in the last 12 months; FMLA needs 1,250.',
    });
  });
});

describe('a request that starts before payroll’s date', () => {
  it('shows payroll’s figure as it is, with nothing accrued', () => {
    setPolicy(VA_POLICY);
    nurseId = hire('2020-01-01', { hours: 80 });
    api().setBalance(nurseId, 'annual', 100, isoDate('2026-10-20'));
    const result = api().checkRequest(
      nurseId,
      'annual',
      isoDate('2026-10-05'),
      isoDate('2026-10-11'),
      40,
    );
    expect(result.balance).toMatchObject({
      balanceHours: 100,
      projectedHours: 100,
      accruedHours: 0,
      usedHours: 0,
      forfeitedHours: 0,
    });
  });
});

describe('a unit with no leave policy', () => {
  it('checks a PTO request against payroll’s figure as it was, with no accrual', () => {
    api().setBalance(nurseId, 'pto', 40, isoDate('2026-08-02'));
    // Five pay periods have closed since payroll's date; with no policy none of them earns.
    expect(check('pto', 36).balance).toMatchObject({
      balanceHours: 40,
      projectedHours: 40,
      accruedHours: 0,
      usedHours: 0,
      forfeitedHours: 0,
      check: { ok: true, remainingHours: 4 },
    });
  });
});

describe('leave for a 72/80 nurse is charged 10 hours for each 9 of absence', () => {
  it('debits 13.33 hours of a 120-hour balance for one 12-hour tour off', () => {
    nurseId = hire('2020-01-01', { hours: 72, scheduleKind: 'va_72_80' });
    api().setBalance(nurseId, 'annual', 120, isoDate('2026-10-01'));
    const earlier = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-10-05'),
        endDate: isoDate('2026-10-05'),
        type: 'annual',
        paidHours: 12,
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, earlier.id, ACTOR);
    const result = api().checkRequest(
      nurseId,
      'annual',
      isoDate('2026-10-12'),
      isoDate('2026-10-12'),
      12,
    );
    // 120 − 12 × 10/9; the second tour is charged the same, leaving 106.67 − 13.33.
    expect(result.balance).toMatchObject({ usedHours: 13.33, projectedHours: 106.67 });
    expect(result.balance!.check).toMatchObject({ ok: true });
    expect((result.balance!.check as { remainingHours: number }).remainingHours).toBeCloseTo(
      93.33,
      2,
    );
    // The stored request is still the 12 worked hours.
    expect(earlier.paidHours).toBe(12);
  });

  it('counts a 72/80 nurse’s approved FMLA week as 36 worked hours, with no 10/9', () => {
    nurseId = hire('2020-01-01', { hours: 72, scheduleKind: 'va_72_80' });
    const earlier = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-08-03'),
        endDate: isoDate('2026-08-09'),
        type: 'fmla',
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, earlier.id, ACTOR);
    const { fmla } = check('fmla', 0);
    // 7 days × 36/7 = 36 hours used, whatever the entitlement's regime.
    expect(fmla!.remainingHours).toBeCloseTo(fmla!.entitlementHours - 36, 2);
    expect(fmla!.requestHours).toBe(36);
  });
});

describe('California’s yearly cap on using sick leave', () => {
  beforeEach(() =>
    setPolicy({
      fmla: { regime: 'title1', yearMethod: 'rolling_backward' },
      leaveYearStart: 'calendar',
      accrual: [
        {
          balanceType: 'sick',
          tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
          balanceCapHours: 80,
          useCapHoursPerYear: 40,
        },
      ],
    }),
  );

  const approvedSick = (date: string, paidHours: number) =>
    approveTimeOff(
      f.handle.db,
      createTimeOffRequest(
        f.handle.db,
        { nurseId, startDate: isoDate(date), endDate: isoDate(date), type: 'sick', paidHours },
        ACTOR,
      ).id,
      ACTOR,
    );

  it('says 16 hours more is 8 past the 40 when 32 were used this year, though the balance has them', () => {
    api().setBalance(nurseId, 'sick', 60, isoDate('2026-10-01'));
    // 24 in March is already in payroll's 60; 8 on 10-02 comes off it. Nothing worked, so the
    // period closing 10-03 earns nothing: 60 − 8 = 52 projected, 24 + 8 = 32 used this year.
    approvedSick('2026-03-02', 24);
    approvedSick('2026-10-02', 8);
    const balance = check('sick', 16).balance!;
    expect(balance).toMatchObject({ projectedHours: 52, usedThisYearHours: 32 });
    expect(balance.check).toEqual({ ok: true, remainingHours: 36 });
    expect(balance.useCap).toEqual({ capHours: 40, overBy: 8 });
  });

  it('says nothing about the cap while the request stays within it', () => {
    api().setBalance(nurseId, 'sick', 60, isoDate('2026-10-01'));
    approvedSick('2026-03-02', 24);
    expect(check('sick', 16).balance!.useCap).toBeUndefined();
  });
});

describe('California’s sick-leave use cap for a nurse on 12-hour shifts', () => {
  beforeEach(() => {
    // The cap in days is counted in the unit's usual shift. The scenario unit also has three 8s,
    // which would make its usual shift 8, so they are retired to leave a unit of 12s.
    for (const s of listShiftTypesForUnit(f.handle.db, f.seeded.unitId)) {
      if (s.durationHours !== 12) deactivateShiftType(f.handle.db, s.id, ACTOR);
    }
    setPolicy({
      fmla: { regime: 'title1', yearMethod: 'rolling_backward' },
      leaveYearStart: 'calendar',
      accrual: [
        {
          balanceType: 'sick',
          tiers: [{ fromYearsOfService: 0, hoursPerAccruedHour: 30 }],
          useCapHoursPerYear: 40,
          useCapDaysPerYear: 5,
        },
      ],
    });
    api().setBalance(nurseId, 'sick', 100, isoDate('2026-10-01'));
    approveTimeOff(
      f.handle.db,
      createTimeOffRequest(
        f.handle.db,
        {
          nurseId,
          startDate: isoDate('2026-03-02'),
          endDate: isoDate('2026-03-04'),
          type: 'sick',
          paidHours: 36,
        },
        ACTOR,
      ).id,
      ACTOR,
    );
  });

  it('does not warn a 12-hour nurse at 48 hours of sick leave against California’s cap', () => {
    // Cap max(40, 5 × 12) = 60; 36 used + 12 asked = 48, within it.
    const balance = check('sick', 12).balance!;
    expect(balance.usedThisYearHours).toBe(36);
    expect(balance.useCap).toBeUndefined();
  });

  it('says three more 12s is 12 hours past her 60-hour cap', () => {
    // 36 used + 36 asked = 72, 12 over 60.
    expect(check('sick', 36).balance!.useCap).toEqual({ capHours: 60, overBy: 12 });
  });
});

describe('a California pregnancy disability leave request', () => {
  it('is saved, and counts a week of the 623.88 hours with two weeks already taken', () => {
    const earlier = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-08-03'),
        endDate: isoDate('2026-08-16'),
        type: 'pregnancy_disability',
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, earlier.id, ACTOR);
    const asked = createTimeOffRequest(
      f.handle.db,
      {
        nurseId,
        startDate: isoDate('2026-10-05'),
        endDate: isoDate('2026-10-11'),
        type: 'pregnancy_disability',
      },
      ACTOR,
    );
    expect(asked.type).toBe('pregnancy_disability');

    const result = check('pregnancy_disability', 0);
    // 36 a week × 17.33 = 623.88; 14 days at 36 a week = 72 used; 623.88 − 72 = 551.88.
    expect(result.pdl).toEqual({
      entitlementHours: 623.88,
      weeklyHours: 36,
      period: { from: '2025-10-06', to: '2026-10-05' },
      usedHours: 72,
      requestHours: 36,
      remainingHours: 551.88,
      basis: 'rolling_year',
    });
    // Not FMLA, and no certification is asked for.
    expect(result.fmla).toBeUndefined();
  });

  const approvedPdl = (from: string, to: string) =>
    approveTimeOff(
      f.handle.db,
      createTimeOffRequest(
        f.handle.db,
        {
          nurseId,
          startDate: isoDate(from),
          endDate: isoDate(to),
          type: 'pregnancy_disability',
        },
        ACTOR,
      ).id,
      ACTOR,
    );
  const certify = (from: string, to: string) =>
    api().addCertification({
      nurseId,
      startDate: isoDate(from),
      endDate: isoDate(to),
      intermittent: false,
    });

  it('counts a second pregnancy fresh, under its own certification', () => {
    certify('2025-12-01', '2026-04-30');
    approvedPdl('2026-02-02', '2026-02-15');
    certify('2026-09-01', '2027-03-31');
    // 36 h a week × 17⅓ = 623.88. February's 14 days belong to the first pregnancy, so none of
    // them is used here (the rolling year would have counted 72); 7 days × 36/7 = 36 asked.
    expect(check('pregnancy_disability', 0).pdl).toEqual({
      entitlementHours: 623.88,
      weeklyHours: 36,
      period: { from: '2026-09-01', to: '2027-03-31' },
      usedHours: 0,
      requestHours: 36,
      remainingHours: 623.88,
      basis: 'certification',
    });
  });

  it('counts one pregnancy’s leave across more than a year under its certification', () => {
    certify('2025-08-01', '2026-12-31');
    approvedPdl('2025-08-04', '2025-08-17');
    approvedPdl('2026-08-03', '2026-08-16');
    // 2 × 14 days × 36/7 = 144; 623.88 − 144 = 479.88. The rolling year sees only August 2026.
    expect(check('pregnancy_disability', 0).pdl).toMatchObject({
      period: { from: '2025-08-01', to: '2026-12-31' },
      usedHours: 144,
      remainingHours: 479.88,
      basis: 'certification',
    });
  });
});
