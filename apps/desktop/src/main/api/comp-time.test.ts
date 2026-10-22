/**
 * Banking a finished schedule's overtime as comp time. A unit of its own, so every figure is
 * hand-computed: 12-hour day shifts, weekly overtime past 44 hours, so four shifts in one work
 * week (48 hours) are 4 hours of overtime, and comp time at 1.5 hours per overtime hour.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type Id,
  type IsoDate,
  isoDate,
} from '@shiftnurse/core';
import {
  auditHistoryFor,
  createAssignment,
  createCompTimeElection,
  createNurse,
  createOvertimeRule,
  createPayRate,
  createPeriod,
  createShiftType,
  createUnit,
  publishSchedule,
  recordCompTimeCredits,
  savePaySettings,
  saveRuleSet,
  setLeaveBalance,
  transact,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaySettings } from '../../shared/api.js';
import { bankCompTime } from './comp-time.js';
import { costReport } from './cost.js';
import { type Fixture, openFixture } from './test-fixture.js';

const ACTOR = 'manager';
const d = isoDate;
/** The period below runs Sun 2026-10-04 to Sat 2026-10-17; this is the Wednesday after. */
const AFTER = d('2026-10-21');

let f: Fixture;
let unitId: Id;
let ruleSetId: Id;
let d12: Id;
let ana: Id;
let bea: Id;

function settings(compTime: PaySettings['compTime']): void {
  savePaySettings(
    f.handle.db,
    unitId,
    {
      callBackMinimumHours: 0,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
      compTime,
    },
    ACTOR,
  );
}

function hire(firstName: string): Id {
  const id = createNurse(
    f.handle.db,
    {
      unitId,
      employeeId: `CT-${firstName}`,
      firstName,
      lastName: 'Comp',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: d('2020-01-01'),
      isChargeEligible: true,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
  createPayRate(
    f.handle.db,
    { nurseId: id, role: null, hourlyRate: 50, effectiveFrom: d('2025-01-01') },
    ACTOR,
  );
  return id;
}

const elect = (nurseId: Id, startsOn: string, endsOn?: string) =>
  createCompTimeElection(
    f.handle.db,
    { unitId, nurseId, startsOn: d(startsOn), ...(endsOn ? { endsOn: d(endsOn) } : {}) },
    ACTOR,
  );

/** Each nurse works Mon–Thu of both weeks: 4 h of overtime a week, 8 in the period. */
function period(publish: boolean): Id {
  const id = createPeriod(
    f.handle.db,
    {
      unitId,
      name: 'Oct 4 to Oct 17',
      startDate: d('2026-10-04'),
      endDate: d('2026-10-17'),
      ruleSetId,
      ruleSetVersion: 1,
    },
    ACTOR,
  ).id;
  const dates = ['05', '06', '07', '08', '12', '13', '14', '15'];
  for (const nurseId of [ana, bea]) {
    for (const day of dates) {
      createAssignment(
        f.handle.db,
        { periodId: id, nurseId, shiftTypeId: d12, date: d(`2026-10-${day}`) as IsoDate },
        ACTOR,
      );
    }
  }
  if (publish) transact(f.handle.db, (tx) => publishSchedule(tx, { periodId: id }, ACTOR));
  return id;
}

beforeEach(() => {
  f = openFixture();
  const db = f.handle.db;
  unitId = createUnit(
    db,
    {
      name: '7 North',
      unitType: 'Med-Surg',
      payPeriodDays: 14,
      payPeriodAnchor: d('2026-01-04'),
    },
    ACTOR,
  ).id;
  ruleSetId = transact(db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: DEFAULT_WEEKEND,
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [],
      },
      ACTOR,
    ),
  ).id;
  d12 = createShiftType(
    db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#333',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  createOvertimeRule(
    db,
    { unitId, basis: 'weekly', thresholdHours: 44, multiplier: 1.5, active: true },
    ACTOR,
  );
  ana = hire('Ana');
  bea = hire('Bea');
  settings({ hoursPerOvertimeHour: 1.5, capHours: 240 });
});

afterEach(() => f.handle.close());

describe('banking comp time for a finished schedule', () => {
  it('banks 6 hours for 4 hours of overtime inside the election, and pays none of it in cash', () => {
    // Ana's election covers only the first week: the second week's 4 hours stay paid overtime.
    elect(ana, '2026-10-01', '2026-10-10');
    const id = period(true);
    const before = costReport(f.handle.db, id, AFTER);
    expect(before.compTime).toEqual({ credits: [], bankedOvertimeHours: 0, canBank: true });

    const rows = bankCompTime(f.handle.db, id, AFTER);
    // Bea elected nothing, so she gets no row.
    expect(rows).toEqual([
      expect.objectContaining({
        nurseId: ana,
        overtimeHours: 4,
        creditedHours: 6,
        paidOvertimeHours: 0,
        periodEndDate: '2026-10-17',
      }),
    ]);
    expect(auditHistoryFor(f.handle.db, 'comp_time_credit', rows[0]!.id)[0]).toMatchObject({
      action: 'create',
      after: { nurseId: ana, creditedHours: 6 },
    });

    const after = costReport(f.handle.db, id, AFTER);
    expect(after.compTime).toEqual({
      credits: [{ nurseId: ana, overtimeHours: 4, creditedHours: 6, paidOvertimeHours: 0 }],
      bankedOvertimeHours: 4,
      canBank: false,
    });
    // Two nurses, 8 h of overtime each, at 0.5 × $50: the schedule's price does not move.
    expect(after.cost.totals.overtimePremium).toBeCloseTo(400, 6);
    expect(after.cost.totals.total).toBeCloseTo(before.cost.totals.total, 6);
  });

  it('banks only the 3 hours left under the 240-hour cap and pays the other 2 overtime hours', () => {
    elect(ana, '2026-10-01', '2026-10-10');
    setLeaveBalance(
      f.handle.db,
      { nurseId: ana, type: 'comp', balanceHours: 237, asOf: d('2026-10-01') },
      ACTOR,
    );
    const id = period(true);
    // 4 h × 1.5 = 6 h earned; 3 fit under the cap, which is 2 overtime hours; 2 are paid.
    expect(bankCompTime(f.handle.db, id, AFTER)).toEqual([
      expect.objectContaining({
        nurseId: ana,
        overtimeHours: 4,
        creditedHours: 3,
        paidOvertimeHours: 2,
      }),
    ]);
    expect(costReport(f.handle.db, id, AFTER).compTime?.bankedOvertimeHours).toBe(2);
  });

  it('caps a nurse payroll never gave a comp figure against what she banked before, from 0', () => {
    settings({ hoursPerOvertimeHour: 1.5, capHours: 9 });
    elect(ana, '2026-09-01');
    const september = createPeriod(
      f.handle.db,
      {
        unitId,
        name: 'Sep 20 to Oct 3',
        startDate: d('2026-09-20'),
        endDate: d('2026-10-03'),
        ruleSetId,
        ruleSetVersion: 1,
      },
      ACTOR,
    ).id;
    transact(f.handle.db, (tx) =>
      recordCompTimeCredits(
        tx,
        september,
        [{ nurseId: ana, overtimeHours: 4, creditedHours: 6, paidOvertimeHours: 0 }],
        ACTOR,
      ),
    );
    const id = period(true);
    // 0 + 6 banked in September leaves 3 under the 9-hour cap: 2 of her 8 overtime hours.
    expect(bankCompTime(f.handle.db, id, AFTER)).toEqual([
      expect.objectContaining({
        nurseId: ana,
        overtimeHours: 8,
        creditedHours: 3,
        paidOvertimeHours: 6,
      }),
    ]);
  });

  it('credits only the overtime worked after an election signed mid-period', () => {
    // Signed Fri Oct 9: week 1's overtime (Thu Oct 8, hours 37–48 of the week) is before it and
    // stays paid; week 2's (Thu Oct 15) is inside it. 4 h × 1.5 = 6 h.
    elect(ana, '2026-10-09');
    const id = period(true);
    expect(bankCompTime(f.handle.db, id, AFTER)).toEqual([
      expect.objectContaining({
        nurseId: ana,
        overtimeHours: 4,
        creditedHours: 6,
        paidOvertimeHours: 0,
      }),
    ]);
  });

  it('offers no banking when the electing nurse worked no overtime inside her election', () => {
    // Mon Oct 5 to Wed Oct 7 are her first 36 hours of the week: none of it is overtime.
    elect(ana, '2026-10-01', '2026-10-07');
    const id = period(true);
    expect(costReport(f.handle.db, id, AFTER).compTime).toEqual({
      credits: [],
      bankedOvertimeHours: 0,
      canBank: false,
    });
  });

  it('banks both weeks for a nurse whose election has no end', () => {
    elect(ana, '2026-10-01');
    const id = period(true);
    // 8 h × 1.5.
    expect(bankCompTime(f.handle.db, id, AFTER)).toEqual([
      expect.objectContaining({ nurseId: ana, overtimeHours: 8, creditedHours: 12 }),
    ]);
  });

  it('refuses to bank the same schedule twice', () => {
    elect(ana, '2026-10-01');
    const id = period(true);
    bankCompTime(f.handle.db, id, AFTER);
    expect(() => bankCompTime(f.handle.db, id, AFTER)).toThrow(
      /^Comp time for this period was already banked on /,
    );
  });

  it('refuses a draft, and a published schedule whose last day has not passed', () => {
    elect(ana, '2026-10-01');
    const draft = period(false);
    const refusal =
      'Comp time is banked once the schedule is published and its last day has passed.';
    expect(() => bankCompTime(f.handle.db, draft, AFTER)).toThrow(refusal);
    expect(costReport(f.handle.db, draft, AFTER).compTime?.canBank).toBe(false);

    transact(f.handle.db, (tx) => publishSchedule(tx, { periodId: draft }, ACTOR));
    // Saturday the 17th is still the schedule's last day.
    expect(() => bankCompTime(f.handle.db, draft, d('2026-10-17'))).toThrow(refusal);
    expect(costReport(f.handle.db, draft, d('2026-10-17')).compTime?.canBank).toBe(false);
  });

  it('refuses when comp time was off in the settings the schedule was published under', () => {
    elect(ana, '2026-10-01');
    settings(null);
    const id = period(true);
    // Switching it on afterwards does not reach a schedule already published.
    settings({ hoursPerOvertimeHour: 1.5, capHours: 240 });
    expect(() => bankCompTime(f.handle.db, id, AFTER)).toThrow(
      'Comp time was off in the pay settings this schedule was published under.',
    );
    expect(costReport(f.handle.db, id, AFTER).compTime).toBeUndefined();
  });

  it('offers no banking when no nurse’s election reaches the schedule', () => {
    elect(ana, '2026-10-18');
    const id = period(true);
    expect(costReport(f.handle.db, id, AFTER).compTime?.canBank).toBe(false);
  });
});
