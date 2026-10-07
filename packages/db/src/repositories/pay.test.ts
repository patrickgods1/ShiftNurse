/**
 * Repository tests for cost configuration: which pay rate is in force, and the rates,
 * differentials, overtime rules and budgets a manager edits.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { ids } from '../ids.js';
import * as s from '../schema.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  createDifferential,
  createOvertimeRule,
  createPayRate,
  deleteDifferential,
  deleteOvertimeRule,
  deletePayRate,
  effectiveRateForNurse,
  getPaySettings,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listDifferentialsForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  paySettingsSaved,
  savePaySettings,
  updateDifferential,
  updateOvertimeRule,
  updatePayRate,
} from './pay.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let _shiftTypeId: string;
let _periodId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
      firstName,
      lastName: 'Nurse',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
}

function insertPayRate(input: {
  nurseId?: string | null;
  role?: 'RN' | 'LPN' | 'CNA' | null;
  hourlyRate: number;
  effectiveFrom: IsoDate;
}): void {
  handle.db
    .insert(s.payRate)
    .values({
      id: ids.payRate(),
      nurseId: input.nurseId ?? null,
      role: input.role ?? null,
      hourlyRate: input.hourlyRate,
      effectiveFrom: input.effectiveFrom,
    })
    .run();
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
  _shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const ruleSet = transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2880,
          mode: 'starts_within',
        },
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [
          {
            ruleId: 'min-rest-between-shifts',
            enabled: true,
            params: { minRestHours: 10, onCallCountsAsWork: false },
          },
        ],
      },
      ACTOR,
    ),
  );
  _periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('effective pay rate', () => {
  it('prefers a per-nurse rate over the role default', () => {
    const nurseId = mkNurse('Paid');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 52, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      52,
    );
  });

  it('picks the latest rate that is not after the query date', () => {
    const nurseId = mkNurse('Raised');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2024-01-01') });
    insertPayRate({ nurseId, hourlyRate: 48, effectiveFrom: isoDate('2025-07-01') });
    insertPayRate({ nurseId, hourlyRate: 51, effectiveFrom: isoDate('2026-01-15') });

    // The day before the newest raise takes effect, the previous rate still applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-14'))?.hourlyRate).toBe(
      48,
    );
    // On the effective date itself, the raise applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      51,
    );
  });

  it('ignores a rate whose effective date is still in the future', () => {
    const nurseId = mkNurse('Future');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 60, effectiveFrom: isoDate('2027-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      45,
    );
  });

  it('falls back to the role default when the nurse has no rate of their own', () => {
    const nurseId = mkNurse('Default');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ role: 'LPN', hourlyRate: 30, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      40,
    );
  });

  it('returns undefined when neither a nurse nor a role rate exists', () => {
    const nurseId = mkNurse('Unpriced');
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))).toBeUndefined();
  });
});

describe('cost configuration', () => {
  it('records a new pay rate with an audit entry and refuses one with no scope', () => {
    const nurseId = mkNurse('Raised');
    const rate = createPayRate(
      handle.db,
      { nurseId, role: null, hourlyRate: 52, effectiveFrom: isoDate('2026-02-01') },
      ACTOR,
    );
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([rate]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'create',
      after: rate,
    });

    expect(() =>
      createPayRate(
        handle.db,
        { nurseId: null, role: null, hourlyRate: 40, effectiveFrom: isoDate('2026-02-01') },
        ACTOR,
      ),
    ).toThrow(/nurse or a role/);
    expect(() =>
      createPayRate(
        handle.db,
        { nurseId, role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2026-02-01') },
        ACTOR,
      ),
    ).toThrow(/not both/);
  });

  it('corrects a mistyped rate in place, keeping the old value in the audit trail', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 84, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    const fixed = updatePayRate(handle.db, rate.id, { hourlyRate: 48 }, ACTOR);
    expect(fixed).toEqual({ ...rate, hourlyRate: 48 });
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'update',
      before: rate,
      after: fixed,
    });
  });

  it('refuses to change anything but the amount or start date of a rate, and writes nothing', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 48, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    expect(() => updatePayRate(handle.db, rate.id, { unitId: 'x' } as never, ACTOR)).toThrow(
      "A pay rate update cannot change 'unitId'",
    );
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([rate]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id).map((e) => e.action)).toEqual([
      'create',
    ]);
  });

  it('refuses a rate that is not a number of dollars, zero or more', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 48, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => updatePayRate(handle.db, rate.id, { hourlyRate: bad }, ACTOR)).toThrow(
        'An hourly rate must be a number of dollars, zero or more.',
      );
    }
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([rate]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id).map((e) => e.action)).toEqual([
      'create',
    ]);
  });

  it('refuses a start date that is not a date', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 48, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    expect(() =>
      updatePayRate(handle.db, rate.id, { effectiveFrom: 'next spring' as IsoDate }, ACTOR),
    ).toThrow('Effective from must be a date.');
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([rate]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id).map((e) => e.action)).toEqual([
      'create',
    ]);
  });

  it('deletes a pay rate and audits what was removed', () => {
    const rate = createPayRate(
      handle.db,
      { nurseId: null, role: 'CNA', hourlyRate: 22, effectiveFrom: isoDate('2026-01-01') },
      ACTOR,
    );
    deletePayRate(handle.db, rate.id, ACTOR);
    expect(listPayRatesForUnit(handle.db, unitId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'pay_rate', rate.id)[0]).toMatchObject({
      action: 'delete',
      before: rate,
    });
  });

  it('keeps a differential as it was and records the save when nothing was changed', () => {
    const night = createDifferential(
      handle.db,
      { unitId, kind: 'night', mode: 'flat', amount: 4.5, active: true },
      ACTOR,
    );
    expect(updateDifferential(handle.db, night.id, {}, ACTOR)).toEqual(night);
    const updates = auditHistoryFor(handle.db, 'differential', night.id).filter(
      (e) => e.action === 'update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.before).toEqual(night);
    expect(updates[0]?.after).toEqual(night);
  });

  describe('clock windows on night and evening differentials', () => {
    const window = { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 };
    const baseNight = () => ({
      unitId,
      kind: 'night' as const,
      mode: 'multiplier' as const,
      amount: 1.1,
      active: true,
    });

    it('reads a windowed differential back identical and an unwindowed one without a window', () => {
      const windowed = createDifferential(handle.db, { ...baseNight(), window }, ACTOR);
      const plain = createDifferential(handle.db, { ...baseNight(), kind: 'weekend' }, ACTOR);
      const listed = listDifferentialsForUnit(handle.db, unitId);
      expect(listed.find((d) => d.id === windowed.id)).toEqual({
        ...baseNight(),
        id: windowed.id,
        window,
      });
      expect(listed.find((d) => d.id === plain.id)?.window).toBeUndefined();
    });

    it('keeps a null whole-shift threshold as null', () => {
      const evening = createDifferential(
        handle.db,
        {
          ...baseNight(),
          kind: 'evening',
          mode: 'flat',
          amount: 2,
          window: { startTime: '15:00', endTime: '23:00', wholeShiftAtHours: null },
        },
        ACTOR,
      );
      expect(listDifferentialsForUnit(handle.db, unitId)[0]?.window?.wholeShiftAtHours).toBeNull();
      expect(evening.window?.wholeShiftAtHours).toBeNull();
    });

    it('sets and clears the window on an update and audits the change', () => {
      const created = createDifferential(handle.db, baseNight(), ACTOR);
      const set = updateDifferential(handle.db, created.id, { window }, ACTOR);
      expect(set.window).toEqual(window);
      const cleared = updateDifferential(handle.db, created.id, { window: null }, ACTOR);
      expect(cleared.window).toBeUndefined();
      const updates = auditHistoryFor(handle.db, 'differential', created.id).filter(
        (e) => e.action === 'update',
      );
      expect(updates.map((e) => (e.before as { window?: unknown }).window)).toEqual([
        window,
        undefined,
      ]);
    });

    it('refuses an evening differential with no window', () => {
      expect(() =>
        createDifferential(
          handle.db,
          { ...baseNight(), kind: 'evening', mode: 'flat', amount: 2 },
          ACTOR,
        ),
      ).toThrow(/evening differential needs a clock window/);
      const created = createDifferential(handle.db, baseNight(), ACTOR);
      expect(() => updateDifferential(handle.db, created.id, { kind: 'evening' }, ACTOR)).toThrow(
        /needs a clock window/,
      );
    });

    it('refuses a window on a kind other than night or evening', () => {
      expect(() =>
        createDifferential(handle.db, { ...baseNight(), kind: 'weekend', window }, ACTOR),
      ).toThrow(/only to night and evening/);
    });

    it('refuses turning a windowed night into a weekend one while it keeps its window', () => {
      const created = createDifferential(handle.db, { ...baseNight(), window }, ACTOR);
      expect(() => updateDifferential(handle.db, created.id, { kind: 'weekend' }, ACTOR)).toThrow(
        /only to night and evening/,
      );
    });

    it('turns a windowed night into a weekend one once its window is cleared in the same save', () => {
      const created = createDifferential(handle.db, { ...baseNight(), window }, ACTOR);
      const changed = updateDifferential(
        handle.db,
        created.id,
        { kind: 'weekend', window: null },
        ACTOR,
      );
      expect(changed.kind).toBe('weekend');
      expect(changed.window).toBeUndefined();
      expect(listDifferentialsForUnit(handle.db, unitId)[0]?.window).toBeUndefined();
      const [update] = auditHistoryFor(handle.db, 'differential', created.id).filter(
        (e) => e.action === 'update',
      );
      expect(update?.before).toMatchObject({ window });
    });

    it('refuses a window time that is not HH:MM', () => {
      expect(() =>
        createDifferential(
          handle.db,
          { ...baseNight(), window: { ...window, startTime: '6pm' } },
          ACTOR,
        ),
      ).toThrow(/must be HH:MM/);
      expect(() =>
        createDifferential(
          handle.db,
          { ...baseNight(), window: { ...window, endTime: '24:00' } },
          ACTOR,
        ),
      ).toThrow(/must be HH:MM/);
    });

    it('refuses a whole-shift threshold of zero or less', () => {
      for (const wholeShiftAtHours of [0, -2]) {
        expect(() =>
          createDifferential(
            handle.db,
            { ...baseNight(), window: { ...window, wholeShiftAtHours } },
            ACTOR,
          ),
        ).toThrow(/more than 0 hours/);
      }
    });
  });

  describe('the consecutive-shift premium’s shifts and days', () => {
    const consecutive = { afterShifts: 4, withinDays: 4 };
    const base = () => ({
      unitId,
      kind: 'consecutive_shift' as const,
      mode: 'multiplier' as const,
      amount: 1.5,
      active: true,
    });

    it('reads the UC premium back with its four shifts in four days', () => {
      const created = createDifferential(handle.db, { ...base(), consecutive }, ACTOR);
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([
        { ...base(), id: created.id, consecutive },
      ]);
    });

    it('refuses the premium without its shifts and days, or with only one of them', () => {
      expect(() => createDifferential(handle.db, base(), ACTOR)).toThrow(
        /needs its shifts and days/,
      );
      expect(() =>
        createDifferential(
          handle.db,
          { ...base(), consecutive: { afterShifts: 4 } as typeof consecutive },
          ACTOR,
        ),
      ).toThrow(/days must be a whole number/);
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    });

    it('refuses zero or fractional shifts and days', () => {
      for (const bad of [
        { afterShifts: 0, withinDays: 4 },
        { afterShifts: 4, withinDays: 2.5 },
      ]) {
        expect(() => createDifferential(handle.db, { ...base(), consecutive: bad }, ACTOR)).toThrow(
          /whole number of at least 1/,
        );
      }
    });

    it('refuses shifts and days on another kind of differential', () => {
      expect(() =>
        createDifferential(handle.db, { ...base(), kind: 'weekend', consecutive }, ACTOR),
      ).toThrow(/only to a consecutive-shift premium/);
    });

    it('changes the trigger on an update and audits what it was', () => {
      const created = createDifferential(handle.db, { ...base(), consecutive }, ACTOR);
      const changed = updateDifferential(
        handle.db,
        created.id,
        { consecutive: { afterShifts: 5, withinDays: 6 } },
        ACTOR,
      );
      expect(changed.consecutive).toEqual({ afterShifts: 5, withinDays: 6 });
      expect(() => updateDifferential(handle.db, created.id, { consecutive: null }, ACTOR)).toThrow(
        /needs its shifts and days/,
      );
      const turned = updateDifferential(
        handle.db,
        created.id,
        { kind: 'weekend', consecutive: null },
        ACTOR,
      );
      expect(turned.consecutive).toBeUndefined();
      const updates = auditHistoryFor(handle.db, 'differential', created.id).filter(
        (e) => e.action === 'update',
      );
      // Newest first: the refused clear wrote nothing.
      expect(updates.map((e) => (e.before as { consecutive?: unknown }).consecutive)).toEqual([
        { afterShifts: 5, withinDays: 6 },
        consecutive,
      ]);
    });
  });

  it('lists every differential for the unit but only active ones for pricing', () => {
    const night = createDifferential(
      handle.db,
      { unitId, kind: 'night', mode: 'flat', amount: 4.5, active: true },
      ACTOR,
    );
    const weekend = createDifferential(
      handle.db,
      { unitId, kind: 'weekend', mode: 'flat', amount: 3, active: true },
      ACTOR,
    );
    const paused = updateDifferential(handle.db, weekend.id, { active: false }, ACTOR);

    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([night, paused]);
    expect(listActiveDifferentials(handle.db, unitId)).toEqual([night]);
    expect(auditHistoryFor(handle.db, 'differential', weekend.id)[0]).toMatchObject({
      action: 'update',
      before: weekend,
      after: paused,
    });

    deleteDifferential(handle.db, night.id, ACTOR);
    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([paused]);
    expect(auditHistoryFor(handle.db, 'differential', night.id)[0]).toMatchObject({
      action: 'delete',
      before: night,
    });
  });

  it('keeps a California extra-day rule that does not pyramid and a VA 15-minute minimum', () => {
    const plain = createOvertimeRule(
      handle.db,
      { unitId, basis: 'weekly', thresholdHours: 40, multiplier: 1.5, active: true },
      ACTOR,
    );
    expect(plain.pyramiding).toBeUndefined();
    expect(plain.minimumMinutes).toBeUndefined();

    const extraDay = createOvertimeRule(
      handle.db,
      {
        unitId,
        basis: 'beyond_scheduled_days',
        thresholdHours: 8,
        multiplier: 2,
        pyramiding: 'none',
        minimumMinutes: 15,
        active: true,
      },
      ACTOR,
    );
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([plain, extraDay]);
    expect(listOvertimeRulesForUnit(handle.db, unitId)[1]).toMatchObject({
      basis: 'beyond_scheduled_days',
      pyramiding: 'none',
      minimumMinutes: 15,
    });

    const cleared = updateOvertimeRule(
      handle.db,
      extraDay.id,
      { pyramiding: null, minimumMinutes: null },
      ACTOR,
    );
    expect(cleared.pyramiding).toBeUndefined();
    expect(cleared.minimumMinutes).toBeUndefined();
    expect(auditHistoryFor(handle.db, 'overtime_rule', extraDay.id)[0]).toMatchObject({
      action: 'update',
      before: { pyramiding: 'none', minimumMinutes: 15 },
      after: cleared,
    });
  });

  it('keeps an overtime rule for one VA plan and a daily rule judged on tour days only', () => {
    const baylor = createOvertimeRule(
      handle.db,
      {
        unitId,
        basis: 'weekly',
        thresholdHours: 40,
        multiplier: 1.5,
        active: true,
        scheduleKinds: ['va_baylor'],
      },
      ACTOR,
    );
    const tourDay = createOvertimeRule(
      handle.db,
      {
        unitId,
        basis: 'daily',
        thresholdHours: 12,
        multiplier: 1.5,
        active: true,
        scheduleKinds: ['va_72_80'],
        tourDays: 'only',
      },
      ACTOR,
    );
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([baylor, tourDay]);
    expect(baylor.scheduleKinds).toEqual(['va_baylor']);
    expect(baylor.tourDays).toBeUndefined();
    expect(tourDay).toMatchObject({ scheduleKinds: ['va_72_80'], tourDays: 'only' });

    const cleared = updateOvertimeRule(
      handle.db,
      tourDay.id,
      { scheduleKinds: null, tourDays: null },
      ACTOR,
    );
    expect(cleared.scheduleKinds).toBeUndefined();
    expect(cleared.tourDays).toBeUndefined();
  });

  it('refuses a tour-day filter on a weekly rule and a plan list pricing cannot read', () => {
    const rule = {
      unitId,
      basis: 'weekly' as const,
      thresholdHours: 40,
      multiplier: 1.5,
      active: true,
    };
    expect(() => createOvertimeRule(handle.db, { ...rule, tourDays: 'only' }, ACTOR)).toThrow(
      'Tour days apply only to a daily overtime rule',
    );
    const kinds =
      'Overtime rule schedule kinds must be one or more of standard, va_72_80, va_baylor';
    expect(() => createOvertimeRule(handle.db, { ...rule, scheduleKinds: [] }, ACTOR)).toThrow(
      kinds,
    );
    expect(() =>
      createOvertimeRule(handle.db, { ...rule, scheduleKinds: ['va_baylor', 'va_baylor'] }, ACTOR),
    ).toThrow(kinds);
    expect(() =>
      createOvertimeRule(handle.db, { ...rule, scheduleKinds: ['other' as never] }, ACTOR),
    ).toThrow(kinds);

    const daily = createOvertimeRule(
      handle.db,
      { ...rule, basis: 'daily', tourDays: 'except' },
      ACTOR,
    );
    expect(() => updateOvertimeRule(handle.db, daily.id, { basis: 'weekly' }, ACTOR)).toThrow(
      'Tour days apply only to a daily overtime rule',
    );
    expect(() =>
      updateOvertimeRule(handle.db, daily.id, { tourDays: 'sometimes' as never }, ACTOR),
    ).toThrow('only or except');
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([daily]);
  });

  it('refuses overtime options pricing cannot read', () => {
    const rule = {
      unitId,
      basis: 'weekly' as const,
      thresholdHours: 40,
      multiplier: 1.5,
      active: true,
    };
    expect(() =>
      createOvertimeRule(handle.db, { ...rule, pyramiding: 'maybe' as never }, ACTOR),
    ).toThrow('stack or none');
    expect(() => createOvertimeRule(handle.db, { ...rule, minimumMinutes: -1 }, ACTOR)).toThrow(
      '0 to 240',
    );
    expect(() => createOvertimeRule(handle.db, { ...rule, minimumMinutes: 7.5 }, ACTOR)).toThrow(
      'whole number',
    );
    const saved = createOvertimeRule(handle.db, rule, ACTOR);
    expect(() =>
      updateOvertimeRule(handle.db, saved.id, { pyramiding: 'maybe' as never }, ACTOR),
    ).toThrow('stack or none');
    expect(() => updateOvertimeRule(handle.db, saved.id, { minimumMinutes: 241 }, ACTOR)).toThrow(
      '0 to 240',
    );
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([saved]);
  });

  it('refuses a premium stacking that is neither compound nor additive', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: 1,
          premiumStacking: 'maybe' as never,
          holidayPayCoversOvertime: false,
        },
        ACTOR,
      ),
    ).toThrow('compound or additive');
  });

  it('round-trips whether holiday pay covers overtime, and reads false for a unit with no row', () => {
    expect(paySettingsSaved(handle.db, unitId)).toBe(false);
    expect(getPaySettings(handle.db, unitId).holidayPayCoversOvertime).toBe(false);
    const settings = {
      callBackMinimumHours: 2,
      premiumStacking: 'additive' as const,
      holidayPayCoversOvertime: true,
    };
    savePaySettings(handle.db, unitId, settings, ACTOR);
    expect(paySettingsSaved(handle.db, unitId)).toBe(true);
    expect(getPaySettings(handle.db, unitId)).toEqual(settings);
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      before: { holidayPayCoversOvertime: false },
      after: { holidayPayCoversOvertime: true },
    });
  });

  it('manages overtime rules the same way', () => {
    const weekly = createOvertimeRule(
      handle.db,
      { unitId, basis: 'weekly', thresholdHours: 40, multiplier: 1.5, active: true },
      ACTOR,
    );
    const daily = createOvertimeRule(
      handle.db,
      { unitId, basis: 'daily', thresholdHours: 12, multiplier: 1.5, active: false },
      ACTOR,
    );
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([weekly, daily]);
    expect(listActiveOvertimeRules(handle.db, unitId)).toEqual([weekly]);

    const doubled = updateOvertimeRule(handle.db, daily.id, { multiplier: 2, active: true }, ACTOR);
    expect(listActiveOvertimeRules(handle.db, unitId)).toEqual([weekly, doubled]);
    expect(auditHistoryFor(handle.db, 'overtime_rule', daily.id)[0]).toMatchObject({
      action: 'update',
      before: daily,
      after: doubled,
    });

    deleteOvertimeRule(handle.db, weekly.id, ACTOR);
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([doubled]);
    expect(auditHistoryFor(handle.db, 'overtime_rule', weekly.id)[0]).toMatchObject({
      action: 'delete',
      before: weekly,
    });
  });

  it("does not list another unit's differentials or overtime rules", () => {
    const other = createUnit(
      handle.db,
      {
        name: 'ICU',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    createDifferential(
      handle.db,
      { unitId: other.id, kind: 'night', mode: 'flat', amount: 9, active: true },
      ACTOR,
    );
    createOvertimeRule(
      handle.db,
      { unitId: other.id, basis: 'daily', thresholdHours: 8, multiplier: 1.5, active: true },
      ACTOR,
    );
    expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([]);
  });
});
