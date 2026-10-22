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
  clearBudget,
  createDifferential,
  createOvertimeRule,
  createPayRate,
  deleteDifferential,
  deleteOvertimeRule,
  deletePayRate,
  effectiveRateForNurse,
  getBudget,
  getPaySettings,
  listActiveDifferentials,
  listActiveOvertimeRules,
  listDifferentialsForUnit,
  listOvertimeRulesForUnit,
  listPayRatesForUnit,
  paySettingsSaved,
  savePaySettings,
  setBudget,
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

  describe('one pay rate per person or role per start date', () => {
    const jan1 = isoDate('2026-01-01');
    const rate = (nurseId: string | null, hourlyRate: number, effectiveFrom: IsoDate) => ({
      nurseId,
      role: nurseId === null ? ('RN' as const) : null,
      hourlyRate,
      effectiveFrom,
    });

    it('refuses a second rate for Ana from the same day, and her correction applies once she changes the first', () => {
      const ana = mkNurse('Ana');
      const first = createPayRate(handle.db, rate(ana, 60, jan1), ACTOR);
      expect(() => createPayRate(handle.db, rate(ana, 62, jan1), ACTOR)).toThrow(
        'Ana Nurse already has a pay rate from Thu Jan 1, 2026; change that one instead.',
      );
      updatePayRate(handle.db, first.id, { hourlyRate: 62 }, ACTOR);
      expect(effectiveRateForNurse(handle.db, ana, 'RN', isoDate('2026-01-10'))?.hourlyRate).toBe(
        62,
      );
    });

    it('refuses a second RN default from the same day', () => {
      createPayRate(handle.db, rate(null, 48, isoDate('2026-01-04')), ACTOR);
      expect(() => createPayRate(handle.db, rate(null, 50, isoDate('2026-01-04')), ACTOR)).toThrow(
        'There is already a default RN rate from Sun Jan 4, 2026; change that one instead.',
      );
    });

    it('refuses moving a rate onto the start date of another', () => {
      const ana = mkNurse('Ana');
      createPayRate(handle.db, rate(ana, 60, jan1), ACTOR);
      const july = createPayRate(handle.db, rate(ana, 64, isoDate('2026-07-01')), ACTOR);
      expect(() => updatePayRate(handle.db, july.id, { effectiveFrom: jan1 }, ACTOR)).toThrow(
        'Ana Nurse already has a pay rate from Thu Jan 1, 2026; change that one instead.',
      );
      expect(
        updatePayRate(handle.db, july.id, { effectiveFrom: isoDate('2026-07-01') }, ACTOR)
          .effectiveFrom,
      ).toBe('2026-07-01');
    });

    it("lets Ana's own rate and the RN default start on the same day", () => {
      const ana = mkNurse('Ana');
      createPayRate(handle.db, rate(null, 48, jan1), ACTOR);
      expect(() => createPayRate(handle.db, rate(ana, 60, jan1), ACTOR)).not.toThrow();
    });

    it('says so when the nurse is gone', () => {
      expect(() => createPayRate(handle.db, rate('nope', 60, jan1), ACTOR)).toThrow(
        'That nurse was not found. Reload the page.',
      );
    });

    it('refuses a negative or undated rate when it is created, as it does when it is changed', () => {
      const dollars = 'An hourly rate must be a number of dollars, zero or more.';
      expect(() => createPayRate(handle.db, rate(null, -5, jan1), ACTOR)).toThrow(dollars);
      expect(() => createPayRate(handle.db, rate(null, Number.NaN, jan1), ACTOR)).toThrow(dollars);
      expect(() =>
        createPayRate(handle.db, rate(null, 48, 'next spring' as IsoDate), ACTOR),
      ).toThrow('Effective from must be a date.');
      expect(listPayRatesForUnit(handle.db, unitId)).toEqual([]);
    });

    it('accepts an empty change to a pay rate and records the save', () => {
      const created = createPayRate(handle.db, rate(null, 48, jan1), ACTOR);
      expect(updatePayRate(handle.db, created.id, {}, ACTOR)).toEqual(created);
      const updates = auditHistoryFor(handle.db, 'pay_rate', created.id).filter(
        (e) => e.action === 'update',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.before).toEqual(created);
      expect(updates[0]?.after).toEqual(created);
    });
  });

  describe('cost writers check their own numbers', () => {
    it('refuses a differential with a negative amount or an unknown mode, on create and on change', () => {
      const base = { unitId, kind: 'weekend' as const, mode: 'flat' as const, active: true };
      expect(() => createDifferential(handle.db, { ...base, amount: -2 }, ACTOR)).toThrow(
        'A flat differential cannot be negative',
      );
      expect(() => createDifferential(handle.db, { ...base, amount: Number.NaN }, ACTOR)).toThrow(
        'A differential amount must be a number, zero or more.',
      );
      expect(() =>
        createDifferential(handle.db, { ...base, amount: 2, mode: 'percent' as never }, ACTOR),
      ).toThrow('A differential is a multiplier or a flat amount.');
      expect(() =>
        createDifferential(handle.db, { ...base, amount: 2, kind: 'moonlight' as never }, ACTOR),
      ).toThrow("A differential's kind must be one of night, evening,");
      const saved = createDifferential(handle.db, { ...base, amount: 2 }, ACTOR);
      expect(() => updateDifferential(handle.db, saved.id, { amount: -1 }, ACTOR)).toThrow(
        'A flat differential cannot be negative',
      );
      expect(() =>
        updateDifferential(handle.db, saved.id, { mode: 'percent' as never }, ACTOR),
      ).toThrow('A differential is a multiplier or a flat amount.');
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([saved]);
    });

    it('refuses an overtime rule paying less than straight time, or with a negative threshold', () => {
      const rule = {
        unitId,
        basis: 'weekly' as const,
        thresholdHours: 40,
        multiplier: 1.5,
        active: true,
      };
      expect(() => createOvertimeRule(handle.db, { ...rule, multiplier: 0.5 }, ACTOR)).toThrow(
        'An overtime multiplier must be 1 or more.',
      );
      expect(() => createOvertimeRule(handle.db, { ...rule, thresholdHours: -1 }, ACTOR)).toThrow(
        'An overtime threshold must be a number of hours, zero or more.',
      );
      expect(() =>
        createOvertimeRule(handle.db, { ...rule, basis: 'monthly' as never }, ACTOR),
      ).toThrow("An overtime rule's basis must be one of daily, weekly,");
      const saved = createOvertimeRule(handle.db, rule, ACTOR);
      expect(() => updateOvertimeRule(handle.db, saved.id, { multiplier: 0.9 }, ACTOR)).toThrow(
        'An overtime multiplier must be 1 or more.',
      );
      expect(listOvertimeRulesForUnit(handle.db, unitId)).toEqual([saved]);
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

    const ucTiers = [
      { fullShiftHours: 8, afterShifts: 6, withinDays: 6 },
      { fullShiftHours: 10, afterShifts: 5, withinDays: 5 },
      { fullShiftHours: 12, afterShifts: 4, withinDays: 4 },
    ];

    it('reads the 2025–2030 tiers for 8s, 10s and 12s back as saved', () => {
      const created = createDifferential(
        handle.db,
        { ...base(), consecutive: { ...consecutive, tiers: ucTiers } },
        ACTOR,
      );
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([
        { ...base(), id: created.id, consecutive: { ...consecutive, tiers: ucTiers } },
      ]);
    });

    it('refuses no tiers, four tiers, two tiers of the same length and fractional numbers', () => {
      const cases: [typeof ucTiers, RegExp][] = [
        [[], /one to three tiers/],
        [[...ucTiers, { fullShiftHours: 9, afterShifts: 5, withinDays: 5 }], /one to three tiers/],
        [
          [
            { fullShiftHours: 12, afterShifts: 4, withinDays: 4 },
            { fullShiftHours: 12, afterShifts: 3, withinDays: 3 },
          ],
          /same hours/,
        ],
        [[{ fullShiftHours: 7.5, afterShifts: 6, withinDays: 6 }], /whole number of at least 1/],
        [[{ fullShiftHours: 8, afterShifts: 0, withinDays: 6 }], /whole number of at least 1/],
      ];
      for (const [tiers, message] of cases) {
        expect(() =>
          createDifferential(
            handle.db,
            { ...base(), consecutive: { ...consecutive, tiers } },
            ACTOR,
          ),
        ).toThrow(message);
      }
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    });

    it('adds tiers on an update and audits the trigger before and after', () => {
      const created = createDifferential(handle.db, { ...base(), consecutive }, ACTOR);
      const changed = updateDifferential(
        handle.db,
        created.id,
        { consecutive: { ...consecutive, tiers: ucTiers } },
        ACTOR,
      );
      expect(changed.consecutive?.tiers).toEqual(ucTiers);
      const [update] = auditHistoryFor(handle.db, 'differential', created.id).filter(
        (e) => e.action === 'update',
      );
      expect((update!.before as { consecutive?: unknown }).consecutive).toEqual(consecutive);
      expect((update!.after as { consecutive?: unknown }).consecutive).toEqual({
        ...consecutive,
        tiers: ucTiers,
      });
    });
  });

  describe('the short-rest premium’s hours off', () => {
    const shortRest = { minHoursOff: 6, scope: 'whole_shift' as const };
    const base = () => ({
      unitId,
      kind: 'short_rest' as const,
      mode: 'multiplier' as const,
      amount: 1.5,
      active: true,
    });

    it('reads the UC premium back with its six hours off', () => {
      const created = createDifferential(handle.db, { ...base(), shortRest }, ACTOR);
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([
        { ...base(), id: created.id, shortRest },
      ]);
    });

    it('refuses the premium without its hours off', () => {
      expect(() => createDifferential(handle.db, base(), ACTOR)).toThrow(/needs its hours off/);
    });

    it('refuses zero hours, more than a day, and an unknown scope', () => {
      for (const minHoursOff of [0, -1, 24.5, Number.NaN]) {
        expect(() =>
          createDifferential(
            handle.db,
            { ...base(), shortRest: { ...shortRest, minHoursOff } },
            ACTOR,
          ),
        ).toThrow(/more than 0 and at most 24/);
      }
      expect(() =>
        createDifferential(
          handle.db,
          {
            ...base(),
            shortRest: { ...shortRest, scope: 'whenever' as unknown as 'whole_shift' },
          },
          ACTOR,
        ),
      ).toThrow(/whole shift or within the window/);
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    });

    it('refuses hours off on another kind of differential', () => {
      expect(() =>
        createDifferential(handle.db, { ...base(), kind: 'weekend', shortRest }, ACTOR),
      ).toThrow(/only to a short-rest premium/);
    });

    it('changes the hours off on an update and audits what they were', () => {
      const created = createDifferential(handle.db, { ...base(), shortRest }, ACTOR);
      const within = { minHoursOff: 12, scope: 'within_window' as const };
      const changed = updateDifferential(handle.db, created.id, { shortRest: within }, ACTOR);
      expect(changed.shortRest).toEqual(within);
      expect(() => updateDifferential(handle.db, created.id, { shortRest: null }, ACTOR)).toThrow(
        /needs its hours off/,
      );
      const [update] = auditHistoryFor(handle.db, 'differential', created.id).filter(
        (e) => e.action === 'update',
      );
      expect((update!.before as { shortRest?: unknown }).shortRest).toEqual(shortRest);
      expect((update!.after as { shortRest?: unknown }).shortRest).toEqual(within);
    });
  });

  describe('a differential the cost engine can price', () => {
    const differentialAudits = () =>
      handle.db
        .select()
        .from(s.auditLog)
        .all()
        .filter((e) => e.entityType === 'differential').length;
    const night = (amount: number, active = true) => ({
      unitId,
      kind: 'night' as const,
      mode: 'flat' as const,
      amount,
      active,
    });

    it('refuses a holiday multiplier of 0.5', () => {
      const before = differentialAudits();
      expect(() =>
        createDifferential(
          handle.db,
          { unitId, kind: 'holiday', mode: 'multiplier', amount: 0.5, active: true },
          ACTOR,
        ),
      ).toThrow(/multiplier must be 1 or more/);
      expect(differentialAudits()).toBe(before);
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([]);
    });

    it('accepts a multiplier of exactly 1', () => {
      const created = createDifferential(
        handle.db,
        { unitId, kind: 'agency', mode: 'multiplier', amount: 1, active: true },
        ACTOR,
      );
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([created]);
    });

    it('accepts on-call standby at 15% of basic pay, as the VA pays it', () => {
      const standby = { unitId, kind: 'on_call' as const, mode: 'multiplier' as const };
      const created = createDifferential(
        handle.db,
        { ...standby, amount: 0.15, active: true },
        ACTOR,
      );
      expect(listDifferentialsForUnit(handle.db, unitId)).toEqual([created]);
      expect(() => updateDifferential(handle.db, created.id, { amount: -0.15 }, ACTOR)).toThrow(
        /on-call multiplier cannot be negative/,
      );
    });

    it('refuses a negative flat differential', () => {
      expect(() => createDifferential(handle.db, night(-2), ACTOR)).toThrow(/cannot be negative/);
    });

    it('refuses clearing a 1.5x holiday premium to zero', () => {
      const holiday = createDifferential(
        handle.db,
        { unitId, kind: 'holiday', mode: 'multiplier', amount: 1.5, active: true },
        ACTOR,
      );
      const before = differentialAudits();
      expect(() => updateDifferential(handle.db, holiday.id, { amount: 0 }, ACTOR)).toThrow(
        /multiplier must be 1 or more/,
      );
      expect(listDifferentialsForUnit(handle.db, unitId)[0]?.amount).toBe(1.5);
      expect(differentialAudits()).toBe(before);
    });

    it('refuses switching a $0.50 flat differential to a multiplier without a new amount', () => {
      const flat = createDifferential(handle.db, night(0.5), ACTOR);
      expect(() => updateDifferential(handle.db, flat.id, { mode: 'multiplier' }, ACTOR)).toThrow(
        /multiplier must be 1 or more/,
      );
    });

    it('refuses a second active night differential', () => {
      createDifferential(handle.db, night(2), ACTOR);
      const before = differentialAudits();
      expect(() => createDifferential(handle.db, night(4), ACTOR)).toThrow(
        /already has an active night differential/,
      );
      expect(differentialAudits()).toBe(before);
      expect(listDifferentialsForUnit(handle.db, unitId)).toHaveLength(1);
    });

    it('lets a new night rate wait inactive, and take over once the old one is off', () => {
      const old = createDifferential(handle.db, night(2), ACTOR);
      const next = createDifferential(handle.db, night(4, false), ACTOR);
      expect(() => updateDifferential(handle.db, next.id, { active: true }, ACTOR)).toThrow(
        /already has an active night differential/,
      );
      updateDifferential(handle.db, old.id, { active: false }, ACTOR);
      updateDifferential(handle.db, next.id, { active: true }, ACTOR);
      expect(listActiveDifferentials(handle.db, unitId).map((d) => d.amount)).toEqual([4]);
    });

    it('lets the one active night differential be re-saved active', () => {
      const only = createDifferential(handle.db, night(2), ACTOR);
      expect(
        updateDifferential(handle.db, only.id, { active: true, amount: 3 }, ACTOR).amount,
      ).toBe(3);
    });

    it('does not count another unit’s night differential', () => {
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
      createDifferential(handle.db, { ...night(9), unitId: other.id }, ACTOR);
      expect(createDifferential(handle.db, night(2), ACTOR).active).toBe(true);
    });

    it('refuses turning a weekend differential into a second night one', () => {
      createDifferential(handle.db, night(2), ACTOR);
      const weekend = createDifferential(handle.db, { ...night(3), kind: 'weekend' }, ACTOR);
      expect(() => updateDifferential(handle.db, weekend.id, { kind: 'night' }, ACTOR)).toThrow(
        /already has an active night differential/,
      );
    });

    it('names the holiday premium when refusing a second one', () => {
      const holiday = { unitId, kind: 'holiday' as const, mode: 'multiplier' as const };
      createDifferential(handle.db, { ...holiday, amount: 1.5, active: true }, ACTOR);
      expect(() =>
        createDifferential(handle.db, { ...holiday, amount: 2, active: true }, ACTOR),
      ).toThrow(
        'This unit already has an active holiday premium, and only one of each kind is paid. Change its amount, or turn it off first.',
      );
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
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock' as const,
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'base' as const,
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
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock' as const,
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base' as const,
    };
    savePaySettings(handle.db, unitId, settings, ACTOR);
    expect(paySettingsSaved(handle.db, unitId)).toBe(true);
    expect(getPaySettings(handle.db, unitId)).toEqual(settings);
    // A unit with no row has no stored settings to have been "before".
    const entry = auditHistoryFor(handle.db, 'pay_settings', unitId)[0];
    expect(entry).toMatchObject({ action: 'create', after: { holidayPayCoversOvertime: true } });
    expect(entry?.before).toBeUndefined();
  });

  it('records a second save as an update with what was stored before', () => {
    const save = (callBackMinimumHours: number) =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock' as const,
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'base' as const,
        },
        ACTOR,
      );
    save(2);
    save(3);
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      action: 'update',
      before: { callBackMinimumHours: 2 },
      after: { callBackMinimumHours: 3 },
    });
  });

  it('reads a unit that never set the reporting-pay notice as two hours', () => {
    // A row saved before the notice existed: the column is null.
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    expect(getPaySettings(handle.db, unitId).reportingPayNoticeHours).toBe(2);
  });

  it('saves a four-hour notice and audits what it was', () => {
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 1,
        premiumStacking: 'compound',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 4,
        overtimeWindowAttribution: 'clock' as const,
        paySpringForwardAsScheduled: false,
        breakPremiumRate: 'base' as const,
      },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId).reportingPayNoticeHours).toBe(4);
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      action: 'update',
      before: { reportingPayNoticeHours: 2 },
      after: { reportingPayNoticeHours: 4 },
    });
  });

  it('reads a unit that never chose as counting each hour in the week it is worked', () => {
    expect(getPaySettings(handle.db, unitId).overtimeWindowAttribution).toBe('clock');
    // A row saved before migration 0047: the column is null.
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    expect(getPaySettings(handle.db, unitId).overtimeWindowAttribution).toBe('clock');
  });

  it('saves start-of-shift attribution and audits what it was', () => {
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 1,
        premiumStacking: 'compound',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'start',
        paySpringForwardAsScheduled: false,
        breakPremiumRate: 'base',
      },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId).overtimeWindowAttribution).toBe('start');
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      action: 'update',
      before: { overtimeWindowAttribution: 'clock' },
      after: { overtimeWindowAttribution: 'start' },
    });
  });

  it('refuses an attribution it does not know', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: 1,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'weekly' as never,
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'base',
        },
        ACTOR,
      ),
    ).toThrow(
      'Choose whether a shift that crosses into a new work week counts each hour in the week it is worked or the whole shift in the week it starts.',
    );
    expect(paySettingsSaved(handle.db, unitId)).toBe(false);
  });

  it('reads a row saved before migration 0051 as paying the spring night as worked and breaks at base', () => {
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    expect(getPaySettings(handle.db, unitId)).toMatchObject({
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
    });
  });

  it('saves the spring night as scheduled and breaks at the regular rate, and audits what they were', () => {
    handle.db
      .insert(s.paySettings)
      .values({ unitId, callBackMinimumHours: 1, updatedAt: Date.now() })
      .run();
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 1,
        premiumStacking: 'compound',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'clock',
        paySpringForwardAsScheduled: true,
        breakPremiumRate: 'regular',
      },
      ACTOR,
    );
    expect(getPaySettings(handle.db, unitId)).toMatchObject({
      paySpringForwardAsScheduled: true,
      breakPremiumRate: 'regular',
    });
    expect(auditHistoryFor(handle.db, 'pay_settings', unitId)[0]).toMatchObject({
      action: 'update',
      before: { paySpringForwardAsScheduled: false, breakPremiumRate: 'base' },
      after: { paySpringForwardAsScheduled: true, breakPremiumRate: 'regular' },
    });
  });

  it('refuses a break premium rate it does not know', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: 1,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 2,
          overtimeWindowAttribution: 'clock',
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'overtime' as never,
        },
        ACTOR,
      ),
    ).toThrow('Choose whether a missed break is paid at the base rate or the regular rate.');
    expect(paySettingsSaved(handle.db, unitId)).toBe(false);
  });

  it('refuses a notice of 25 hours', () => {
    expect(() =>
      savePaySettings(
        handle.db,
        unitId,
        {
          callBackMinimumHours: 1,
          premiumStacking: 'compound',
          holidayPayCoversOvertime: false,
          reportingPayNoticeHours: 25,
          overtimeWindowAttribution: 'clock' as const,
          paySpringForwardAsScheduled: false,
          breakPremiumRate: 'base' as const,
        },
        ACTOR,
      ),
    ).toThrow('The reporting-pay notice must be between 0 and 24 hours');
    expect(paySettingsSaved(handle.db, unitId)).toBe(false);
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

describe('a period budget', () => {
  it('sets a budget, then changes it with the old figure on the record', () => {
    const first = setBudget(handle.db, unitId, _periodId, 50_000, ACTOR);
    setBudget(handle.db, unitId, _periodId, 75_000, ACTOR);
    expect(getBudget(handle.db, _periodId)?.targetDollars).toBe(75_000);
    const history = auditHistoryFor(handle.db, 'budget', first.id);
    expect(history.map((e) => e.action)).toEqual(['update', 'create']);
    expect(history[0]?.before).toMatchObject({ targetDollars: 50_000 });
  });

  it('refuses a negative budget and a period from another unit', () => {
    expect(() => setBudget(handle.db, unitId, _periodId, -1, ACTOR)).toThrow(
      'A budget must be a number of dollars, zero or more.',
    );
    expect(() => setBudget(handle.db, unitId, _periodId, Number.NaN, ACTOR)).toThrow(
      'A budget must be a number of dollars, zero or more.',
    );
    const other = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    expect(() => setBudget(handle.db, other.id, _periodId, 1000, ACTOR)).toThrow(
      'That schedule period is not on this unit.',
    );
    expect(() => setBudget(handle.db, unitId, 'nope', 1000, ACTOR)).toThrow(
      'That schedule period was not found. Reload the page.',
    );
    expect(getBudget(handle.db, _periodId)).toBeUndefined();
  });
});

describe('removing a period budget', () => {
  it('removes a period’s budget and records what it was', () => {
    const saved = setBudget(handle.db, unitId, _periodId, 90_000, ACTOR);
    clearBudget(handle.db, _periodId, ACTOR);
    expect(getBudget(handle.db, _periodId)).toBeUndefined();
    expect(auditHistoryFor(handle.db, 'budget', saved.id)[0]).toMatchObject({
      action: 'delete',
      before: { targetDollars: 90_000 },
    });
  });

  it('writes nothing when there is no budget to remove', () => {
    clearBudget(handle.db, _periodId, ACTOR);
    expect(
      handle.db
        .select()
        .from(s.auditLog)
        .all()
        .filter((r) => r.entityType === 'budget'),
    ).toHaveLength(0);
  });
});
