/**
 * Pay configuration and the period cost report through the IPC handlers. A budget is the one
 * write a manager does every period, so it must update in place and leave both figures in the
 * audit log; pay rules must refuse a nonsense scope in words.
 */

import {
  addDays,
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type Id,
  type IsoDate,
  isoDate,
} from '@shiftnurse/core';
import {
  auditHistoryFor,
  createAssignment,
  createDayOfPayEvent,
  createDifferential,
  createHoliday,
  createNurse,
  createOvertimeRule,
  createPayRate,
  createPeriod,
  createShiftType,
  createUnit,
  latestPayConfigSnapshot,
  listPeriodsForUnit,
  publishSchedule,
  savePaySettings,
  saveRuleSet,
  transact,
  updateDifferential,
  updateHoliday,
  updateOvertimeRule,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costApi } from './cost.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => costApi(f.handle.db);
const auditsOf = (type: string, id: string) => auditHistoryFor(f.handle.db, type, id);

describe('pay rates', () => {
  it('sets a nurse’s own rate, raises it, and deletes it, auditing each', () => {
    const rate = api().createPayRate({
      nurseId: f.rns[0]!.id,
      role: null,
      hourlyRate: 61,
      effectiveFrom: isoDate('2026-01-01'),
    });
    expect(
      api()
        .payRates(f.seeded.unitId)
        .map((r) => r.id),
    ).toContain(rate.id);
    expect(api().updatePayRate(rate.id, { hourlyRate: 64 }).hourlyRate).toBe(64);
    api().deletePayRate(rate.id);
    expect(
      api()
        .payRates(f.seeded.unitId)
        .some((r) => r.id === rate.id),
    ).toBe(false);
    expect(auditsOf('pay_rate', rate.id).map((a) => a.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
  });

  it('refuses a rate for both a nurse and a role in words', () => {
    expect(() =>
      api().createPayRate({
        nurseId: f.rns[0]!.id,
        role: 'RN',
        hourlyRate: 50,
        effectiveFrom: isoDate('2026-01-01'),
      }),
    ).toThrow(/nurse or a role, not both/i);
  });

  it('says so when deleting a rate that is not there', () => {
    expect(() => api().deletePayRate('nope')).toThrow(/not found/i);
  });
});

describe('differentials and overtime rules', () => {
  it('adds a weekend premium, changes it and removes it', () => {
    // The seeded unit already has an active agency premium, and a second of a kind is refused.
    const d = api().createDifferential({
      unitId: f.seeded.unitId,
      kind: 'call_back',
      mode: 'flat',
      amount: 12,
      active: true,
    });
    expect(
      api()
        .differentials(f.seeded.unitId)
        .map((x) => x.id),
    ).toContain(d.id);
    expect(api().updateDifferential(d.id, { amount: 15 }).amount).toBe(15);
    api().deleteDifferential(d.id);
    expect(
      api()
        .differentials(f.seeded.unitId)
        .some((x) => x.id === d.id),
    ).toBe(false);
    expect(auditsOf('differential', d.id)).toHaveLength(3);
  });

  it('adds a daily overtime rule, changes its multiplier and removes it', () => {
    const r = api().createOvertimeRule({
      unitId: f.seeded.unitId,
      basis: 'daily',
      thresholdHours: 12,
      multiplier: 1.5,
      active: true,
    });
    expect(
      api()
        .overtimeRules(f.seeded.unitId)
        .map((x) => x.id),
    ).toContain(r.id);
    expect(api().updateOvertimeRule(r.id, { multiplier: 2 }).multiplier).toBe(2);
    api().deleteOvertimeRule(r.id);
    expect(
      api()
        .overtimeRules(f.seeded.unitId)
        .some((x) => x.id === r.id),
    ).toBe(false);
    expect(auditsOf('overtime_rule', r.id)).toHaveLength(3);
  });

  it('says so when removing a differential or an overtime rule that is gone', () => {
    expect(() => api().deleteDifferential('x')).toThrow(/not found/i);
    expect(() => api().deleteOvertimeRule('x')).toThrow(/not found/i);
  });
});

describe('the period budget and cost report', () => {
  it('sets a budget, then changes it in place and keeps the old figure in the audit row', () => {
    const periodId = f.seeded.draftPeriodId;
    const first = api().setBudget(periodId, 90_000);
    const second = api().setBudget(periodId, 95_000);
    expect(second.id).toBe(first.id);
    expect(api().report(periodId).budget?.targetDollars).toBe(95_000);
    const [latest] = auditsOf('budget', first.id);
    expect(latest!.before).toMatchObject({ targetDollars: 90_000 });
    expect(latest!.after).toMatchObject({ targetDollars: 95_000 });
  });

  it('says so when setting a budget for a period that does not exist', () => {
    expect(() => api().setBudget('no-period', 1000)).toThrow(
      'That schedule period no longer exists. Reload the page.',
    );
  });

  it('clears a budget through the API', () => {
    const periodId = f.seeded.draftPeriodId;
    const set = api().setBudget(periodId, 90_000);
    api().clearBudget(periodId);
    expect(api().report(periodId).budget).toBeUndefined();
    expect(auditsOf('budget', set.id)[0]).toMatchObject({
      action: 'delete',
      before: { targetDollars: 90_000 },
    });
  });

  it('refuses to clear the budget of a period that does not exist', () => {
    expect(() => api().clearBudget('no-period')).toThrow(/no longer exists/i);
  });

  it('prices the shifts on the grid and compares the total with the budget', () => {
    const periodId = f.seeded.draftPeriodId;
    expect(api().report(periodId).cost.totals.total).toBe(0);
    scheduleApi(f.handle.db).createAssignment({
      periodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 1),
    });
    api().setBudget(periodId, 50_000);
    const report = api().report(periodId);
    expect(report.cost.totals.total).toBeGreaterThan(0);
    expect(report.variance).toMatchObject({ targetDollars: 50_000 });
    expect(report.variance!.actualDollars).toBeGreaterThan(0);
    expect(report.variance!.actualDollars).toBeLessThan(50_000);
  });
});

describe('repricing a published schedule', () => {
  it('reprices a published schedule through the app with a reason', () => {
    const published = listPeriodsForUnit(f.handle.db, f.seeded.unitId).find(
      (p) => p.status === 'published',
    )!;
    // The seeded history went out through the publish path, so it already keeps its settings.
    expect(latestPayConfigSnapshot(f.handle.db, published.id)?.seq).toBe(1);
    const snap = api().reprice(published.id, 'Retroactive raise per 2026 contract');
    expect(snap).toMatchObject({ seq: 2, reason: 'Retroactive raise per 2026 contract' });
    expect(auditsOf('pay_config_snapshot', published.id)[0]).toMatchObject({
      action: 'create',
      reason: 'Retroactive raise per 2026 contract',
    });
  });

  it('refuses to reprice a draft through the app', () => {
    expect(() => api().reprice(f.seeded.draftPeriodId, 'Contract change')).toThrow(
      /is a draft; a draft is always priced with today’s pay settings/,
    );
    expect(latestPayConfigSnapshot(f.handle.db, f.seeded.draftPeriodId)).toBeUndefined();
  });
});

describe('a published schedule keeps its price', () => {
  // A unit of its own, so every dollar below is one hand-computed line: Ana at $50 an hour.
  const ACTOR = 'manager';
  let unitId: Id;
  let ruleSetId: Id;
  let ana: Id;

  beforeEach(() => {
    const db = f.handle.db;
    unitId = createUnit(
      db,
      {
        name: '6 East',
        unitType: 'Med-Surg',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
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
    ana = createNurse(
      db,
      {
        unitId,
        employeeId: 'E6-1',
        firstName: 'Ana',
        lastName: 'Reyes',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
    createPayRate(
      db,
      { nurseId: ana, role: null, hourlyRate: 50, effectiveFrom: isoDate('2025-01-01') },
      ACTOR,
    );
  });

  function shiftType(
    abbreviation: string,
    startTime: string,
    isNight: boolean,
    isOnCall = false,
  ): Id {
    return createShiftType(
      f.handle.db,
      {
        unitId,
        name: abbreviation,
        abbreviation,
        startTime,
        durationHours: 12,
        isNight,
        isOnCall,
        color: '#333',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
  }

  /** A period holding Ana's shifts on these dates, left a draft or published. */
  function period(
    start: string,
    end: string,
    shiftTypeId: Id,
    dates: string[],
    publish: boolean,
  ): Id {
    const id = createPeriod(
      f.handle.db,
      {
        unitId,
        name: `${start} to ${end}`,
        startDate: isoDate(start),
        endDate: isoDate(end),
        ruleSetId,
        ruleSetVersion: 1,
      },
      ACTOR,
    ).id;
    for (const date of dates) {
      createAssignment(
        f.handle.db,
        { periodId: id, nurseId: ana, shiftTypeId, date: isoDate(date) as IsoDate },
        ACTOR,
      );
    }
    if (publish) transact(f.handle.db, (tx) => publishSchedule(tx, { periodId: id }, ACTOR));
    return id;
  }

  function nightDifferential(amount: number): Id {
    return createDifferential(
      f.handle.db,
      { unitId, kind: 'night', mode: 'multiplier', amount, active: true },
      ACTOR,
    ).id;
  }

  it('keeps last month’s night shift at the differential it was published with', () => {
    const n12 = shiftType('N12', '19:00', true);
    const diff = nightDifferential(1.1);
    const published = period('2026-10-04', '2026-10-17', n12, ['2026-10-05'], true);
    // 12 h × $50 × 1.10.
    expect(api().report(published).cost.totals.total).toBeCloseTo(660, 6);

    updateDifferential(f.handle.db, diff, { amount: 1.2 }, ACTOR);
    expect(api().report(published).cost.totals.total).toBeCloseTo(660, 6);
    expect(api().report(published).pricedUnder?.takenAt).toEqual(expect.any(Number));
    // 12 h × $50 × 1.20.
    const draft = period('2026-11-15', '2026-11-28', n12, ['2026-11-16'], false);
    expect(api().report(draft).cost.totals.total).toBeCloseTo(720, 6);
  });

  it('keeps overtime on a published week after the overtime rule is switched off', () => {
    const d12 = shiftType('D12', '07:00', false);
    const rule = createOvertimeRule(
      f.handle.db,
      { unitId, basis: 'weekly', thresholdHours: 40, multiplier: 1.5, active: true },
      ACTOR,
    ).id;
    // Monday to Thursday, 48 h in one work week: 8 h over 40.
    const published = period(
      '2026-10-04',
      '2026-10-17',
      d12,
      ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'],
      true,
    );
    const before = api().report(published).cost.totals;
    expect(before.overtimeHours).toBe(8);
    // 8 h × 0.5 × $50.
    expect(before.overtimePremium).toBeCloseTo(200, 6);

    updateOvertimeRule(f.handle.db, rule, { active: false }, ACTOR);
    const after = api().report(published).cost.totals;
    expect(after.overtimeHours).toBe(8);
    expect(after.overtimePremium).toBeCloseTo(200, 6);
    const draft = period(
      '2026-11-15',
      '2026-11-28',
      d12,
      ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
      false,
    );
    expect(api().report(draft).cost.totals.overtimeHours).toBe(0);
  });

  it('keeps the holiday premium on a published Christmas after the holiday is moved', () => {
    const d12 = shiftType('D12', '07:00', false);
    createDifferential(
      f.handle.db,
      { unitId, kind: 'holiday', mode: 'multiplier', amount: 1.5, active: true },
      ACTOR,
    );
    const christmas = createHoliday(
      f.handle.db,
      {
        unitId,
        date: isoDate('2026-12-25'),
        name: 'Christmas Day',
        isMajor: true,
        pairedHolidayId: null,
      },
      ACTOR,
    ).id;
    const published = period('2026-12-20', '2027-01-02', d12, ['2026-12-25'], true);
    // 12 h × $50 × 1.5.
    expect(api().report(published).cost.totals.total).toBeCloseTo(900, 6);

    transact(f.handle.db, (tx) =>
      updateHoliday(
        tx,
        christmas,
        { date: isoDate('2026-12-26') },
        ACTOR,
        'Observed on the 26th this year',
      ),
    );
    expect(api().report(published).cost.totals.total).toBeCloseTo(900, 6);
  });

  it('keeps a call-back’s minimum hours on a published schedule after the contract changes', () => {
    const d12 = shiftType('D12', '07:00', false);
    const settings = (callBackMinimumHours: number) =>
      savePaySettings(
        f.handle.db,
        unitId,
        {
          callBackMinimumHours,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock',
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'base',
          compTime: null,
        },
        ACTOR,
      );
    const standby = shiftType('SB', '19:00', true, true);
    const callBack = (date: string) =>
      createDayOfPayEvent(
        f.handle.db,
        {
          unitId,
          nurseId: ana,
          kind: 'call_back',
          date: isoDate(date),
          shiftTypeId: standby,
          startMinute: 120,
          hoursWorked: 1,
        },
        ACTOR,
      );
    settings(4);
    const published = period('2026-10-04', '2026-10-17', d12, [], true);
    callBack('2026-10-06');
    // A 1 h call-back paid at the 4 h minimum: 4 × $50.
    expect(api().report(published).dayOf.total).toBeCloseTo(200, 6);

    settings(2);
    expect(api().report(published).dayOf.total).toBeCloseTo(200, 6);
    const draft = period('2026-11-15', '2026-11-28', d12, [], false);
    callBack('2026-11-17');
    // The new 2 h minimum: 2 × $50.
    expect(api().report(draft).dayOf.total).toBeCloseTo(100, 6);
  });

  it('prices with today’s settings once the manager reprices with a reason', () => {
    const n12 = shiftType('N12', '19:00', true);
    const diff = nightDifferential(1.1);
    const published = period('2026-10-04', '2026-10-17', n12, ['2026-10-05'], true);
    updateDifferential(f.handle.db, diff, { amount: 1.2 }, ACTOR);
    api().reprice(published, 'Retroactive raise');
    const report = api().report(published);
    // 12 h × $50 × 1.20.
    expect(report.cost.totals.total).toBeCloseTo(720, 6);
    expect(report.pricedUnder?.reason).toBe('Retroactive raise');
  });

  it('prices a draft with today’s settings', () => {
    const n12 = shiftType('N12', '19:00', true);
    const draft = period('2026-11-15', '2026-11-28', n12, ['2026-11-16'], false);
    expect(api().report(draft).pricedUnder).toBeUndefined();
  });
});
