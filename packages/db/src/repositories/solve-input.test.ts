/**
 * `loadPeriodInput` is the one definition of "the period" that Generate, the conflict detector,
 * costing and the benchmark all share. What it gets wrong, every one of them gets wrong the same
 * way — so its unit boundaries are tested here directly: another unit's nurses, rates and
 * shifts must never leak into a solve, and the rates a solve prices with must be exactly the
 * ones the cost screen would resolve.
 */

import {
  addDays,
  dayNumber,
  defaultRuleSet,
  isoDate,
  type SchedulePeriod,
  type SolveInput,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { dayOfPayEvent } from '../schema.js';
import { seedScenarioUnit } from '../seed/scenarios.js';
import type { SeedResult } from '../seed/types.js';
import { createRatioRule, listActiveRatioRulesForUnit, updateRatioRule } from './acuity.js';
import { createAvailabilityBlock, listAvailabilityBlocks } from './availability-blocks.js';
import { paidSickCallsForUnit, reportCallOff } from './calloffs.js';
import {
  createShiftType,
  createUnit,
  getUnit,
  listShiftTypesForUnit,
  updateUnit,
} from './config.js';
import { createDayOfPayEvent } from './day-of-pay.js';
import { createIncompatibilityGroup } from './incompatibility.js';
import { createNurseUnit } from './nurse-units.js';
import { createOvertimeVolunteer } from './overtime-volunteers.js';
import {
  createPayRate,
  getPaySettings,
  listActiveOvertimeRules,
  listPayRatesForUnit,
  savePaySettings,
  updateOvertimeRule,
} from './pay.js';
import { createPreceptorship } from './preceptorships.js';
import { publishSchedule } from './publish.js';
import { createRestWaiver, restWaiversForPeriod } from './rest-waivers.js';
import {
  createNurse,
  grantCredential,
  listCredentials,
  listNurseCredentialsForUnit,
  listNursesForUnit,
  listPreferencesForUnit,
  replaceNursePreferences,
} from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  archivePeriod,
  createAssignment,
  createPeriod,
  deleteAssignment,
  getPeriod,
  listAssignmentsForPeriodOnDate,
  listPeriodsForUnit,
  markFloatedOff,
} from './schedule.js';
import {
  costContext,
  historyFromFor,
  loadPeriodInput,
  timeOffForPeriod,
  timeOffWindow,
} from './solve-input.js';
import { approveTimeOff, createTimeOffRequest, listTimeOffForUnit } from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let seeded: SeedResult;

beforeEach(() => {
  handle = openTestDatabase();
  seeded = transact(handle.db, (tx) =>
    seedScenarioUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 2 }),
  );
});

afterEach(() => {
  handle.close();
});

function otherUnitNurseWithRate(): { nurseId: string; rateId: string } {
  const other = createUnit(
    handle.db,
    {
      name: '5 East',
      unitType: 'ICU',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  const nurse = createNurse(
    handle.db,
    {
      unitId: other.id,
      employeeId: 'X-001',
      firstName: 'Other',
      lastName: 'Unit',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: false,
      active: true,
    },
    ACTOR,
  );
  const rate = createPayRate(
    handle.db,
    { nurseId: nurse.id, role: null, hourlyRate: 99, effectiveFrom: isoDate('2026-01-01') },
    ACTOR,
  );
  return { nurseId: nurse.id, rateId: rate.id };
}

describe('loadPeriodInput', () => {
  it.skipIf(process.env.SHIFTNURSE_TEST_TZ !== undefined)(
    'tells the rules and Generate about the clock change inside the period',
    () => {
      const base = getPeriod(handle.db, seeded.draftPeriodId)!;
      const period = { ...base, startDate: isoDate('2026-10-25'), endDate: isoDate('2026-11-07') };
      // 2026-11-01 is day 20758; 20758 * 1440 + 120 = 29_891_640, and the clock goes back an hour.
      expect(loadPeriodInput(handle.db, period as SchedulePeriod).dstTransitions).toContainEqual({
        atMinute: 29_891_640,
        deltaMinutes: -60,
      });
    },
  );

  it('loads the draft with only its own unit’s nurses and shift types', () => {
    const other = otherUnitNurseWithRate();
    const input = loadPeriodInput(handle.db, getPeriod(handle.db, seeded.draftPeriodId)!);

    expect(input.nurses.map((n) => n.id)).toEqual(
      listNursesForUnit(handle.db, seeded.unitId).map((n) => n.id),
    );
    expect(input.nurses.some((n) => n.id === other.nurseId)).toBe(false);
    expect(input.shiftTypes).toEqual(listShiftTypesForUnit(handle.db, seeded.unitId));
    expect(input.demand.length).toBeGreaterThan(0);
  });

  it('carries the groups that can apply to the period, and none that ended before it', () => {
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const [a, b] = listNursesForUnit(handle.db, seeded.unitId);
    const group = (name: string, endsOn?: string) =>
      transact(handle.db, (tx) =>
        createIncompatibilityGroup(
          tx,
          {
            unitId: seeded.unitId,
            name,
            nurseIds: [a!.id, b!.id],
            maxTogether: 1,
            ...(endsOn ? { endsOn: isoDate(endsOn) } : {}),
          },
          'test',
          ACTOR,
        ),
      );
    const current = group('Current');
    // Ends the evening before: its night still shares the first morning with the period.
    const lastNight = group('Last night', addDays(period.startDate, -1));
    group('Long over', addDays(period.startDate, -2));
    const input = loadPeriodInput(handle.db, period);
    expect(input.incompatibilityGroups!.map((g) => g.id).sort()).toEqual(
      [current.id, lastNight.id].sort(),
    );
  });

  it('carries the overtime offers from the lookback tail to the period end, and no others', () => {
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const [a] = listNursesForUnit(handle.db, seeded.unitId);
    const offer = (start: string, end: string) =>
      createOvertimeVolunteer(
        handle.db,
        { unitId: seeded.unitId, nurseId: a!.id, startDate: isoDate(start), endDate: isoDate(end) },
        ACTOR,
      );
    // The tail is 28 days: an offer on its first day counts, one ending the day before does not.
    const inTail = offer(addDays(period.startDate, -28), addDays(period.startDate, -28));
    const inPeriod = offer(period.startDate, period.endDate);
    offer(addDays(period.startDate, -34), addDays(period.startDate, -29));
    offer(addDays(period.endDate, 1), addDays(period.endDate, 3));
    const input = loadPeriodInput(handle.db, period);
    expect(input.overtimeVolunteers!.map((v) => v.id)).toEqual([inTail.id, inPeriod.id]);
  });

  it('carries the preceptorships from the lookback tail to the period end, and no others', () => {
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const [a, b] = listNursesForUnit(handle.db, seeded.unitId);
    const pair = (start: string, end: string) =>
      createPreceptorship(
        handle.db,
        {
          unitId: seeded.unitId,
          orienteeId: a!.id,
          preceptorId: b!.id,
          startDate: isoDate(start),
          endDate: isoDate(end),
        },
        ACTOR,
      );
    const inTail = pair(addDays(period.startDate, -28), addDays(period.startDate, -28));
    const inPeriod = pair(period.startDate, period.endDate);
    pair(addDays(period.startDate, -40), addDays(period.startDate, -29));
    pair(addDays(period.endDate, 1), addDays(period.endDate, 30));
    const input = loadPeriodInput(handle.db, period);
    expect(input.preceptorships!.map((p) => p.id)).toEqual([inTail.id, inPeriod.id]);
  });

  it('prices with the role defaults and this unit’s own rates, never another unit’s nurse rate', () => {
    const other = otherUnitNurseWithRate();
    const unitNurseIds = new Set(listNursesForUnit(handle.db, seeded.unitId).map((n) => n.id));
    const ownRate = createPayRate(
      handle.db,
      {
        nurseId: [...unitNurseIds][0]!,
        role: null,
        hourlyRate: 61.5,
        effectiveFrom: isoDate('2026-01-01'),
      },
      ACTOR,
    );

    const input = loadPeriodInput(handle.db, getPeriod(handle.db, seeded.draftPeriodId)!);
    const rates = input.cost!.payRates;

    expect(rates.some((r) => r.id === other.rateId)).toBe(false);
    expect(rates.some((r) => r.id === ownRate.id)).toBe(true);
    expect(rates.some((r) => r.nurseId === null)).toBe(true);
    expect(rates.every((r) => r.nurseId === null || unitNurseIds.has(r.nurseId))).toBe(true);
    // The order the rates were written in: resolvePayRate keeps the first of two rates that
    // take effect on the same day, so a reordered list would change what a shift costs.
    expect(rates.at(-1)?.id).toBe(ownRate.id);
    expect(listPayRatesForUnit(handle.db, seeded.unitId)).toEqual(rates);
  });
});

describe('the pay a period is costed under', () => {
  it('prices compounding unless the unit has chosen additive premiums', () => {
    const unitId = seeded.unitId;
    const ruleSet = defaultRuleSet(unitId);
    expect(costContext(handle.db, unitId, ruleSet).premiumStacking).toBe('compound');
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 0,
        premiumStacking: 'additive',
        holidayPayCoversOvertime: false,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'clock',
        paySpringForwardAsScheduled: false,
        breakPremiumRate: 'base',
        compTime: null,
      },
      ACTOR,
    );
    expect(costContext(handle.db, unitId, ruleSet).premiumStacking).toBe('additive');
  });

  it('hands the unit’s stacking, holiday coverage and week attribution to Generate and conflicts', () => {
    const unitId = seeded.unitId;
    savePaySettings(
      handle.db,
      unitId,
      {
        callBackMinimumHours: 0,
        premiumStacking: 'additive',
        holidayPayCoversOvertime: true,
        reportingPayNoticeHours: 2,
        overtimeWindowAttribution: 'start',
        paySpringForwardAsScheduled: false,
        breakPremiumRate: 'base',
        compTime: null,
      },
      ACTOR,
    );
    const input = loadPeriodInput(handle.db, getPeriod(handle.db, seeded.draftPeriodId)!);
    expect(input.cost).toMatchObject({
      premiumStacking: 'additive',
      holidayPayCoversOvertime: true,
      overtimeWindowAttribution: 'start',
    });
    expect(costContext(handle.db, unitId, defaultRuleSet(unitId)).overtimeWindowAttribution).toBe(
      'start',
    );
  });

  it('prices the spring night as scheduled and breaks at the regular rate once the unit says so', () => {
    const unitId = seeded.unitId;
    const ruleSet = defaultRuleSet(unitId);
    expect(costContext(handle.db, unitId, ruleSet)).toMatchObject({
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
    });
    savePaySettings(
      handle.db,
      unitId,
      {
        ...getPaySettings(handle.db, unitId),
        paySpringForwardAsScheduled: true,
        breakPremiumRate: 'regular',
        compTime: null,
      },
      ACTOR,
    );
    expect(costContext(handle.db, unitId, ruleSet)).toMatchObject({
      paySpringForwardAsScheduled: true,
      breakPremiumRate: 'regular',
    });
  });

  // Skipped off the pinned zone (phase 1's sentinel): the clock change is a host fact.
  it.skipIf(process.env.SHIFTNURSE_TEST_TZ !== undefined)(
    'hands the period’s clock changes to the cost context',
    () => {
      const base = getPeriod(handle.db, seeded.draftPeriodId)!;
      const period = {
        ...base,
        startDate: isoDate('2026-10-25'),
        endDate: isoDate('2026-11-07'),
      } as SchedulePeriod;
      const ctx = costContext(handle.db, seeded.unitId, defaultRuleSet(seeded.unitId), period);
      // 2026-11-01 is day 20758; 20758 * 1440 + 120 = 29_891_640.
      expect(ctx.dstTransitions).toContainEqual({ atMinute: 29_891_640, deltaMinutes: -60 });
      expect(
        costContext(handle.db, seeded.unitId, defaultRuleSet(seeded.unitId)).dstTransitions,
      ).toBeUndefined();
    },
  );
});

describe('the pay a published period went out under', () => {
  const published = () =>
    listPeriodsForUnit(handle.db, seeded.unitId).find((p) => p.status === 'published')!;
  const draft = () => getPeriod(handle.db, seeded.draftPeriodId)!;

  it('gives Generate and conflicts the overtime rules a published period went out under', () => {
    const rules = listActiveOvertimeRules(handle.db, seeded.unitId);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) updateOvertimeRule(handle.db, r.id, { active: false }, ACTOR);
    expect(loadPeriodInput(handle.db, published()).cost!.overtimeRules.map((r) => r.id)).toEqual(
      rules.map((r) => r.id),
    );
    expect(loadPeriodInput(handle.db, draft()).cost!.overtimeRules).toEqual([]);
  });

  it('keeps the stacking, holiday coverage and week attribution a published period went out under', () => {
    const old = getPaySettings(handle.db, seeded.unitId);
    const changed = {
      ...old,
      premiumStacking: old.premiumStacking === 'compound' ? 'additive' : 'compound',
      holidayPayCoversOvertime: !old.holidayPayCoversOvertime,
      overtimeWindowAttribution: old.overtimeWindowAttribution === 'clock' ? 'start' : 'clock',
    } as const;
    savePaySettings(handle.db, seeded.unitId, changed, ACTOR);
    expect(loadPeriodInput(handle.db, published()).cost).toMatchObject({
      premiumStacking: old.premiumStacking,
      holidayPayCoversOvertime: old.holidayPayCoversOvertime,
      overtimeWindowAttribution: old.overtimeWindowAttribution,
    });
    expect(loadPeriodInput(handle.db, draft()).cost).toMatchObject({
      premiumStacking: changed.premiumStacking,
      holidayPayCoversOvertime: changed.holidayPayCoversOvertime,
      overtimeWindowAttribution: changed.overtimeWindowAttribution,
    });
  });

  it('judges a published period under the holiday attribution it was published with', () => {
    // The scenario unit never chose one, so its schedules went out under the start-day reading.
    expect(getUnit(handle.db, seeded.unitId)?.holidayAttribution).toBeUndefined();
    transact(handle.db, (tx) =>
      updateUnit(tx, seeded.unitId, { holidayAttribution: 'clock' }, ACTOR),
    );
    expect(loadPeriodInput(handle.db, published()).unit.holidayAttribution).toBeUndefined();
    expect(loadPeriodInput(handle.db, draft()).unit.holidayAttribution).toBe('clock');
  });
});

describe('the leave a period reads', () => {
  const march = { startDate: isoDate('2026-03-01'), endDate: isoDate('2026-03-14') };

  it('reaches back a lookback and a pay period, and forward a pay period', () => {
    // 14-day pay period: 03-01 less (28 + 14) days is 01-18; 03-14 plus 14 days is 03-28.
    expect(timeOffWindow({ payPeriodDays: 14 }, march)).toEqual({
      start: '2026-01-18',
      end: '2026-03-28',
    });
  });

  it('never shrinks the slack below a work week on a short pay period', () => {
    // 7-day pay period: 03-01 less (28 + 7) is 01-25; 03-14 plus 7 is 03-21.
    expect(timeOffWindow({ payPeriodDays: 7 }, march)).toEqual({
      start: '2026-01-25',
      end: '2026-03-21',
    });
    // A 5-day one still gets 7: 03-01 less 35 and 03-14 plus 7.
    expect(timeOffWindow({ payPeriodDays: 5 }, march)).toEqual({
      start: '2026-01-25',
      end: '2026-03-21',
    });
  });

  it('keeps a request from the window edge and drops one a day outside it', () => {
    const nurseId = listNursesForUnit(handle.db, seeded.unitId)[0]!.id;
    const ask = (start: string, end: string) =>
      createTimeOffRequest(
        handle.db,
        { nurseId, startDate: isoDate(start), endDate: isoDate(end), type: 'pto' },
        ACTOR,
      ).id;
    const endedBefore = ask('2026-01-11', '2026-01-17');
    const endsOnStart = ask('2026-01-11', '2026-01-18');
    const startsOnEnd = ask('2026-03-28', '2026-04-05');
    const startsAfter = ask('2026-03-29', '2026-04-05');

    const period = { ...march, unitId: seeded.unitId } as SchedulePeriod;
    const ids = timeOffForPeriod(handle.db, { payPeriodDays: 14 }, period).map((r) => r.id);

    expect(ids).not.toContain(endedBefore);
    expect(ids).toContain(endsOnStart);
    expect(ids).toContain(startsOnEnd);
    expect(ids).not.toContain(startsAfter);
  });

  it('hands the solver a long paid leave that straddles the window start, whole', () => {
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const unit = listNursesForUnit(handle.db, seeded.unitId)[0]!;
    const { start } = timeOffWindow({ payPeriodDays: 14 }, period);
    const leave = createTimeOffRequest(
      handle.db,
      {
        nurseId: unit.id,
        startDate: addDays(start, -10),
        endDate: addDays(start, 10),
        type: 'pto',
        paidHours: 36,
      },
      ACTOR,
    );
    const input = loadPeriodInput(handle.db, period);
    const found = input.timeOff.find((r) => r.id === leave.id);
    expect(found).toMatchObject({
      startDate: addDays(start, -10),
      endDate: addDays(start, 10),
      paidHours: 36,
    });
  });

  it('lists leave in start-date order whatever the order it was entered in', () => {
    const nurseId = listNursesForUnit(handle.db, seeded.unitId)[0]!.id;
    for (const [s, e] of [
      ['2027-05-10', '2027-05-11'],
      ['2027-05-01', '2027-05-02'],
      ['2027-05-05', '2027-05-06'],
    ] as const) {
      createTimeOffRequest(
        handle.db,
        { nurseId, startDate: isoDate(s), endDate: isoDate(e), type: 'pto' },
        ACTOR,
      );
    }
    const starts = listTimeOffForUnit(handle.db, seeded.unitId)
      .filter((r) => r.startDate.startsWith('2027-05'))
      .map((r) => r.startDate);
    expect(starts).toEqual(['2027-05-01', '2027-05-05', '2027-05-10']);
  });
});

describe('how the unit keeps its ratios', () => {
  function draftInput() {
    return loadPeriodInput(handle.db, getPeriod(handle.db, seeded.draftPeriodId)!);
  }
  /** Demand rows for RNs where the ratio governs a shift with its own charge nurse. */
  function standaloneRatioRows(input: ReturnType<typeof draftInput>) {
    const standalone = new Set(
      input.shiftTypes.filter((t) => t.withinShiftTypeId === null && !t.isOnCall).map((t) => t.id),
    );
    return input.demand
      .filter((d) => standalone.has(d.shiftTypeId) && d.byRole.RN.ratioBedside > 0)
      .map((d) => d.byRole.RN);
  }

  it('reads an existing unit as before: the charge nurse at the bedside, no break cover', () => {
    const rows = standaloneRatioRows(draftInput());
    expect(rows.length).toBeGreaterThan(0);
    for (const rn of rows) {
      expect(rn.ratioDerived).toBe(rn.ratioBedside);
      expect(rn.chargeWithoutPatients).toBe(0);
      expect(rn.breakRelief).toBe(0);
    }
  });

  it('asks every forecast shift for one more RN once the charge nurse takes no patients', () => {
    transact(handle.db, (tx) =>
      updateUnit(
        tx,
        seeded.unitId,
        {
          ratioStaffing: {
            chargeNurseTakesPatients: false,
            breakMinutesPerNurse: 0,
            chargeCoversBreaks: false,
          },
        },
        ACTOR,
      ),
    );
    const rows = standaloneRatioRows(draftInput());
    expect(rows.length).toBeGreaterThan(0);
    for (const rn of rows) expect(rn.ratioDerived).toBe(rn.ratioBedside + 1);
  });

  it('keeps the setting on the unit with the change in the audit log', () => {
    const before = getUnit(handle.db, seeded.unitId)!;
    expect(before.ratioStaffing).toEqual({
      chargeNurseTakesPatients: true,
      breakMinutesPerNurse: 0,
      chargeCoversBreaks: false,
    });
    const staffing = {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 60,
      chargeCoversBreaks: true,
    };
    transact(handle.db, (tx) => updateUnit(tx, seeded.unitId, { ratioStaffing: staffing }, ACTOR));
    expect(getUnit(handle.db, seeded.unitId)!.ratioStaffing).toEqual(staffing);
    const [latest] = auditHistoryFor(handle.db, 'unit', seeded.unitId);
    expect(latest).toMatchObject({
      action: 'update',
      before: { ratioStaffing: { chargeNurseTakesPatients: true } },
      after: { ratioStaffing: staffing },
    });
  });

  it('refuses break minutes that are not a whole number a shift can hold', () => {
    const bad = (breakMinutesPerNurse: number) => () =>
      transact(handle.db, (tx) =>
        updateUnit(
          tx,
          seeded.unitId,
          {
            ratioStaffing: {
              chargeNurseTakesPatients: true,
              breakMinutesPerNurse,
              chargeCoversBreaks: false,
            },
          },
          ACTOR,
        ),
      );
    expect(bad(-15)).toThrow('Break minutes per nurse must be a whole number from 0 to 240');
    expect(bad(22.5)).toThrow('whole number');
    expect(bad(300)).toThrow('whole number');
    expect(getUnit(handle.db, seeded.unitId)!.ratioStaffing!.breakMinutesPerNurse).toBe(0);
  });
});

describe("the unit's schedule posting notice", () => {
  const setLead = (postingLeadDays: number | null) =>
    transact(handle.db, (tx) => updateUnit(tx, seeded.unitId, { postingLeadDays }, ACTOR));

  it('keeps a 14-day notice on the unit and clears it again', () => {
    expect(getUnit(handle.db, seeded.unitId)!.postingLeadDays).toBeUndefined();
    setLead(14);
    expect(getUnit(handle.db, seeded.unitId)!.postingLeadDays).toBe(14);
    const [latest] = auditHistoryFor(handle.db, 'unit', seeded.unitId);
    expect(latest).toMatchObject({ action: 'update', after: { postingLeadDays: 14 } });
    setLead(null);
    expect(getUnit(handle.db, seeded.unitId)!.postingLeadDays).toBeUndefined();
  });

  it('refuses a notice that is not a whole number of days up to 90', () => {
    expect(() => setLead(-1)).toThrow('whole number of days from 0 to 90');
    expect(() => setLead(10.5)).toThrow('whole number of days from 0 to 90');
    expect(() => setLead(91)).toThrow('whole number of days from 0 to 90');
    expect(getUnit(handle.db, seeded.unitId)!.postingLeadDays).toBeUndefined();
  });
});

describe("the unit's promise of weekends off per year", () => {
  const setWeekends = (minWeekendsOffPerYear: number | null) =>
    transact(handle.db, (tx) => updateUnit(tx, seeded.unitId, { minWeekendsOffPerYear }, ACTOR));

  it('keeps a 26-weekend promise on the unit and clears it again', () => {
    expect(getUnit(handle.db, seeded.unitId)!.minWeekendsOffPerYear).toBeUndefined();
    setWeekends(26);
    expect(getUnit(handle.db, seeded.unitId)!.minWeekendsOffPerYear).toBe(26);
    const [latest] = auditHistoryFor(handle.db, 'unit', seeded.unitId);
    expect(latest).toMatchObject({ action: 'update', after: { minWeekendsOffPerYear: 26 } });
    expect(
      (latest!.before as { minWeekendsOffPerYear?: number }).minWeekendsOffPerYear,
    ).toBeUndefined();
    setWeekends(null);
    expect(getUnit(handle.db, seeded.unitId)!.minWeekendsOffPerYear).toBeUndefined();
    const [cleared] = auditHistoryFor(handle.db, 'unit', seeded.unitId);
    expect(cleared).toMatchObject({ action: 'update', before: { minWeekendsOffPerYear: 26 } });
  });

  it('refuses a promise of more weekends off than a year has', () => {
    const msg = 'Weekends off per year must be a whole number from 0 to 52';
    expect(() => setWeekends(53)).toThrow(msg);
    expect(() => setWeekends(-1)).toThrow(msg);
    expect(() => setWeekends(10.5)).toThrow(msg);
    expect(getUnit(handle.db, seeded.unitId)!.minWeekendsOffPerYear).toBeUndefined();
  });
});

describe('a licensed-nurse ratio', () => {
  function licensedRule(minRnShare?: number) {
    return createRatioRule(
      handle.db,
      {
        unitId: seeded.unitId,
        role: 'licensed',
        acuityTierId: null,
        maxPatientsPerNurse: 5,
        citation: 'Cal. Code Regs. tit. 22 § 70217(a)(11)',
        ...(minRnShare !== undefined ? { minRnShare } : {}),
        active: true,
      },
      ACTOR,
    );
  }

  it('keeps its RN share and reaches the period as a pooled requirement', () => {
    const rule = licensedRule(0.5);
    expect(
      listActiveRatioRulesForUnit(handle.db, seeded.unitId).find((r) => r.id === rule.id),
    ).toMatchObject({ role: 'licensed', minRnShare: 0.5 });
    const input = loadPeriodInput(handle.db, getPeriod(handle.db, seeded.draftPeriodId)!);
    const pooled = input.demand.filter((d) => d.licensed !== undefined);
    expect(pooled.length).toBeGreaterThan(0);
    for (const d of pooled) {
      // Half the licensed nurses, rounded up, must be RNs.
      expect(d.licensed!.minRn).toBe(Math.ceil(d.licensed!.ratioDerived / 2));
    }
  });

  it('clears the share with null, and refuses one on a single-role rule or past 100%', () => {
    const rule = licensedRule(0.5);
    const cleared = transact(handle.db, (tx) =>
      updateRatioRule(tx, rule.id, { minRnShare: null }, ACTOR, 'RN mix agreed with the union'),
    );
    expect(cleared.minRnShare).toBeUndefined();
    expect(() =>
      transact(handle.db, (tx) => updateRatioRule(tx, rule.id, { minRnShare: 1.5 }, ACTOR)),
    ).toThrow('The share of RNs must be more than 0% and at most 100%');
    expect(() =>
      transact(handle.db, (tx) =>
        updateRatioRule(tx, rule.id, { role: 'RN', minRnShare: 0.5 }, ACTOR),
      ),
    ).toThrow('Only a licensed-nurse ratio can require a share of RNs');
  });
});

describe('nurses who work on two units', () => {
  function westWing() {
    const west = createUnit(
      handle.db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const night = createShiftType(
      handle.db,
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
    const rules = transact(handle.db, (tx) => saveRuleSet(tx, defaultRuleSet(west.id), ACTOR));
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const mkPeriod = () =>
      createPeriod(
        handle.db,
        {
          unitId: west.id,
          name: 'West',
          startDate: period.startDate,
          endDate: period.endDate,
          ruleSetId: rules.id,
          ruleSetVersion: rules.version,
        },
        ACTOR,
      );
    return { west, night, period, mkPeriod };
  }

  const floater = (unitId: string, employeeId: string) =>
    createNurse(
      handle.db,
      {
        unitId,
        employeeId,
        firstName: 'Fran',
        lastName: 'Float',
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
    );

  it('carries a night worked on 5 West as locked busy time on an inactive shift type', () => {
    const { night, period, mkPeriod } = westWing();
    const [ana] = listNursesForUnit(handle.db, seeded.unitId);
    const westPeriod = mkPeriod();
    const shift = createAssignment(
      handle.db,
      { periodId: westPeriod.id, nurseId: ana!.id, shiftTypeId: night.id, date: period.startDate },
      ACTOR,
    );
    const input = loadPeriodInput(handle.db, period);
    const busy = input.priorAssignments!.filter((a) => a.shiftTypeId.startsWith('elsewhere:'));
    expect(busy).toEqual([
      { ...shift, shiftTypeId: `elsewhere:${night.id}`, isLocked: true, isCharge: false },
    ]);
    expect(input.shiftTypes.find((t) => t.id === `elsewhere:${night.id}`)).toMatchObject({
      name: 'Night 12 on 5 West',
      active: false,
      startTime: '19:00',
    });
  });

  it('counts a draft and an archived period on 5 West as busy time', () => {
    const { night, period, mkPeriod } = westWing();
    const [ana] = listNursesForUnit(handle.db, seeded.unitId);
    const draft = mkPeriod();
    const old = mkPeriod();
    const place = (periodId: string, date: string) =>
      createAssignment(
        handle.db,
        { periodId, nurseId: ana!.id, shiftTypeId: night.id, date: isoDate(date) },
        ACTOR,
      );
    const planned = place(draft.id, period.startDate);
    const archivedRow = place(old.id, addDays(period.startDate, 1));
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: old.id }, ACTOR));
    archivePeriod(handle.db, old.id, ACTOR, 'Closed pay period');
    const busy = loadPeriodInput(handle.db, period).priorAssignments!.filter((a) =>
      a.shiftTypeId.startsWith('elsewhere:'),
    );
    expect(busy.map((a) => a.id)).toEqual([planned.id, archivedRow.id]);
  });

  it('puts nurses floated in from 5 West after the home roster', () => {
    const { west, period } = westWing();
    const fran = floater(west.id, 'W-100');
    createNurseUnit(handle.db, { nurseId: fran.id, unitId: seeded.unitId }, ACTOR);
    const input = loadPeriodInput(handle.db, period);
    const home = listNursesForUnit(handle.db, seeded.unitId);
    expect(input.nurses.map((n) => n.id)).toEqual([...home.map((n) => n.id), fran.id]);
  });

  it('reads a unit nobody floats to exactly as before: its own nurses, no busy time', () => {
    westWing();
    const period = getPeriod(handle.db, seeded.draftPeriodId)!;
    const unitId = seeded.unitId;
    const input = loadPeriodInput(handle.db, period);
    expect(input.nurses).toEqual(listNursesForUnit(handle.db, unitId));
    expect(input.shiftTypes.every((t) => !t.id.startsWith('elsewhere:'))).toBe(true);
    expect(input.priorAssignments!.every((a) => !a.shiftTypeId.startsWith('elsewhere:'))).toBe(
      true,
    );
    expect(input.shiftTypes.every((t) => !t.id.startsWith('floated:'))).toBe(true);
    expect(input.priorAssignments!.every((a) => !a.shiftTypeId.startsWith('floated:'))).toBe(true);
    // Today's unit-scoped loaders, in today's order: the solver samples by index.
    expect(input.availabilityBlocks).toEqual(listAvailabilityBlocks(handle.db, unitId));
    expect(input.restWaivers).toEqual(
      restWaiversForPeriod(handle.db, unitId, period.startDate, period.endDate),
    );
    expect(input.paidSickCalls).toEqual(
      paidSickCallsForUnit(handle.db, unitId, {
        start: addDays(period.startDate, -28),
        end: period.endDate,
      }),
    );
    expect(input.cost!.payRates).toEqual(listPayRatesForUnit(handle.db, unitId));
    expect(input.nurseCredentials).toEqual(listNurseCredentialsForUnit(handle.db, unitId));
    expect(input.preferences).toEqual(listPreferencesForUnit(handle.db, unitId));
  });

  /**
   * Fran is homed on 5 West and floats to the seeded unit for the draft. One of each record she
   * carries is kept on 5 West (or on her), and the two the seeded unit itself records for her.
   */
  function franCarriesEverything() {
    const { west, night, period, mkPeriod } = westWing();
    const fran = floater(west.id, 'W-100');
    createNurseUnit(
      handle.db,
      {
        nurseId: fran.id,
        unitId: seeded.unitId,
        startDate: addDays(period.startDate, -28),
        endDate: period.endDate,
      },
      ACTOR,
    );
    grantCredential(
      handle.db,
      { nurseId: fran.id, credentialId: listCredentials(handle.db)[0]!.id },
      ACTOR,
    );
    transact(handle.db, (tx) =>
      replaceNursePreferences(
        tx,
        fran.id,
        [{ id: 'pref-fran', nurseId: fran.id, kind: 'avoid_weekday', weekday: 0, weight: 1 }],
        ACTOR,
      ),
    );
    const leaveDay = addDays(period.startDate, 4);
    const leave = createTimeOffRequest(
      handle.db,
      { nurseId: fran.id, startDate: leaveDay, endDate: leaveDay, type: 'pto', paidHours: 12 },
      ACTOR,
    );
    approveTimeOff(handle.db, leave.id, ACTOR);
    // A sick call is credited only once her shift is off the schedule.
    const westPeriod = mkPeriod();
    const missed = createAssignment(
      handle.db,
      { periodId: westPeriod.id, nurseId: fran.id, shiftTypeId: night.id, date: period.startDate },
      ACTOR,
    );
    reportCallOff(handle.db, missed.id, ACTOR, 'Sick', { paidSickHours: 12 });
    deleteAssignment(handle.db, missed.id, ACTOR);
    createRestWaiver(
      handle.db,
      {
        unitId: west.id,
        nurseId: fran.id,
        date: addDays(period.startDate, 2),
        reason: 'Asked to work the short turnaround',
      },
      ACTOR,
    );
    createAvailabilityBlock(
      handle.db,
      {
        unitId: west.id,
        nurseId: fran.id,
        weekdays: [5],
        startTime: '18:00',
        endTime: '18:00',
        reason: 'Observes the Sabbath',
      },
      ACTOR,
    );
    createPayRate(
      handle.db,
      { nurseId: fran.id, role: null, hourlyRate: 77, effectiveFrom: isoDate('2020-01-01') },
      ACTOR,
    );
    createOvertimeVolunteer(
      handle.db,
      {
        unitId: seeded.unitId,
        nurseId: fran.id,
        startDate: period.startDate,
        endDate: period.endDate,
      },
      ACTOR,
    );
    const preceptor = listNursesForUnit(handle.db, seeded.unitId).find(
      (n) => n.role === 'RN' && !n.isNovice,
    )!;
    createPreceptorship(
      handle.db,
      {
        unitId: seeded.unitId,
        orienteeId: fran.id,
        preceptorId: preceptor.id,
        startDate: period.startDate,
        endDate: period.endDate,
      },
      ACTOR,
    );
    // On call on 5 West the second night, from 19:00; called in at 21:00 for three hours.
    const standby = createShiftType(
      handle.db,
      {
        unitId: west.id,
        name: 'On call',
        abbreviation: 'OC',
        startTime: '19:00',
        durationHours: 12,
        isNight: false,
        isOnCall: true,
        color: '#000',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    );
    const calledIn = addDays(period.startDate, 1);
    createDayOfPayEvent(
      handle.db,
      {
        kind: 'call_back',
        unitId: west.id,
        nurseId: fran.id,
        date: calledIn,
        shiftTypeId: standby.id,
        startMinute: 120,
        hoursWorked: 3,
      },
      ACTOR,
    );
    return { fran, period, west, standby, calledIn };
  }

  it('brings everything a floated-in nurse carries: credentials, preferences, leave, sick pay, waivers, accommodations and her own pay rate', () => {
    const { fran, period } = franCarriesEverything();
    const input = loadPeriodInput(handle.db, period);
    const hers = (rows: readonly { nurseId: string | null }[] | undefined) =>
      (rows ?? []).filter((r) => r.nurseId === fran.id);
    expect(hers(input.timeOff)).toHaveLength(1);
    expect(hers(input.paidSickCalls)).toHaveLength(1);
    expect(hers(input.nurseCredentials)).toHaveLength(1);
    expect(hers(input.preferences)).toHaveLength(1);
    expect(hers(input.restWaivers)).toHaveLength(1);
    expect(hers(input.availabilityBlocks)).toHaveLength(1);
    expect(hers(input.overtimeVolunteers)).toHaveLength(1);
    expect(hers(input.cost!.payRates)).toHaveLength(1);
    expect(hers(input.cost!.payRates)[0]).toMatchObject({ hourlyRate: 77 });
    expect(input.preceptorships!.filter((p) => p.orienteeId === fran.id)).toHaveLength(1);
    expect(hers(input.callBacks)).toHaveLength(1);
  });

  it('places a timed call-back where it was worked and leaves out one with no time or no hours', () => {
    const { fran, period, west, standby, calledIn } = franCarriesEverything();
    // Recorded before call-backs had a time: pay-only, so it cannot be put on the clock.
    handle.db
      .insert(dayOfPayEvent)
      .values({
        id: 'dope-old',
        unitId: west.id,
        nurseId: fran.id,
        kind: 'call_back',
        date: addDays(period.startDate, 3),
        shiftTypeId: standby.id,
        hoursWorked: 2,
        startMinute: null,
        enteredBy: 'manager',
        createdAt: Date.now(),
      })
      .run();
    // Timed, but of no hours: it covers no time on the clock.
    handle.db
      .insert(dayOfPayEvent)
      .values({
        id: 'dope-zero',
        unitId: west.id,
        nurseId: fran.id,
        kind: 'call_back',
        date: addDays(period.startDate, 5),
        shiftTypeId: standby.id,
        hoursWorked: 0,
        startMinute: 60,
        enteredBy: 'manager',
        createdAt: Date.now(),
      })
      .run();
    const hers = loadPeriodInput(handle.db, period).callBacks!.filter((c) => c.nurseId === fran.id);
    // Standby from 19:00 on the second day, in at 21:00 (120 minutes), out at midnight.
    const midnight = dayNumber(calledIn) * 1440;
    expect(hers).toEqual([
      {
        nurseId: fran.id,
        window: { startMinute: midnight + 21 * 60, endMinute: midnight + 24 * 60 },
      },
    ]);
  });

  it('classifies every field of the solve input as the person’s, the unit’s or the roster’s', () => {
    type Scope = 'person' | 'recordedHere' | 'unit' | 'roster';
    // 'unit' lists are unit-scoped by design:
    // - unit, period, ruleSet, shiftTypes, demand, credentials, shiftCredentialRequirements and
    //   holidays describe the unit itself (credentials is the catalogue, not who holds what);
    // - assignments and priorAssignments are this unit's shifts (others' arrive as busy time);
    // - historyFrom is how far this unit's published history reaches;
    // - dstTransitions are the host's clock changes over this period's dates;
    // - incompatibilityGroups keep apart nurses on this unit's floor;
    // - holidayWork is this unit's holiday rotation;
    // - ledgerHistory is this unit's fairness ledger.
    // 'recordedHere' lists are this unit's own records, which a float may now hold: an offer to
    // work extra here, an orientation to this unit.
    const SCOPE = {
      unit: 'unit',
      period: 'unit',
      ruleSet: 'unit',
      nurses: 'roster',
      shiftTypes: 'unit',
      demand: 'unit',
      assignments: 'unit',
      priorAssignments: 'unit',
      historyFrom: 'unit',
      dstTransitions: 'unit',
      timeOff: 'person',
      paidSickCalls: 'person',
      incompatibilityGroups: 'unit',
      credentials: 'unit',
      nurseCredentials: 'person',
      shiftCredentialRequirements: 'unit',
      holidays: 'unit',
      holidayWork: 'unit',
      overtimeVolunteers: 'recordedHere',
      preceptorships: 'recordedHere',
      restWaivers: 'person',
      availabilityBlocks: 'person',
      callBacks: 'person',
      preferences: 'person',
      ledgerHistory: 'unit',
      cost: 'person',
    } as const satisfies Record<keyof SolveInput, Scope>;

    const { fran, period } = franCarriesEverything();
    const input = loadPeriodInput(handle.db, period);
    const carried = (Object.keys(SCOPE) as (keyof SolveInput)[]).filter(
      (k) => SCOPE[k] === 'person' || SCOPE[k] === 'recordedHere',
    );
    for (const key of carried) {
      const rows = (key === 'cost' ? input.cost!.payRates : (input[key] ?? [])) as readonly Record<
        string,
        unknown
      >[];
      const owner = key === 'preceptorships' ? 'orienteeId' : 'nurseId';
      expect(
        rows.some((r) => r[owner] === fran.id),
        `${key} carries Fran's row`,
      ).toBe(true);
    }
  });

  describe('how far published history reaches', () => {
    function twoPeriods(earlier: 'published' | 'archived' | 'draft') {
      const unit = createUnit(
        handle.db,
        {
          name: '6 North',
          unitType: 'ICU',
          payPeriodDays: 14,
          payPeriodAnchor: isoDate('2026-01-04'),
        },
        ACTOR,
      );
      const rules = transact(handle.db, (tx) => saveRuleSet(tx, defaultRuleSet(unit.id), ACTOR));
      const mk = (name: string, startDate: string, endDate: string) =>
        createPeriod(
          handle.db,
          {
            unitId: unit.id,
            name,
            startDate: isoDate(startDate),
            endDate: isoDate(endDate),
            ruleSetId: rules.id,
            ruleSetVersion: rules.version,
          },
          ACTOR,
        );
      const before = mk('Before', '2026-01-04', '2026-01-17');
      if (earlier !== 'draft')
        transact(handle.db, (tx) => publishSchedule(tx, { periodId: before.id }, ACTOR));
      if (earlier === 'archived') archivePeriod(handle.db, before.id, ACTOR, 'Pay period closed');
      return mk('Now', '2026-01-18', '2026-01-31');
    }

    it('says the history reaches back through the published schedule before this one', () => {
      expect(historyFromFor(handle.db, twoPeriods('published'))).toBe('2026-01-04');
    });

    it('still reaches back through the schedule before once it has been archived', () => {
      expect(historyFromFor(handle.db, twoPeriods('archived'))).toBe('2026-01-04');
    });

    it('says there is no history when the schedule before is still a draft', () => {
      expect(historyFromFor(handle.db, twoPeriods('draft'))).toBe('2026-01-18');
    });

    it('hands the solver the same date', () => {
      const draft = twoPeriods('published');
      expect(loadPeriodInput(handle.db, draft).historyFrom).toBe(historyFromFor(handle.db, draft));
    });
  });
});

describe('a draft laid over another schedule of the same unit', () => {
  /** Period A on the draft's own unit and dates, with Ana on Day 12 on the draft's fourth day. */
  function overlapping() {
    const draft = getPeriod(handle.db, seeded.draftPeriodId)!;
    const day = listShiftTypesForUnit(handle.db, seeded.unitId).find(
      (t) => t.abbreviation === 'D12',
    )!;
    const [ana] = listNursesForUnit(handle.db, seeded.unitId);
    const a = createPeriod(
      handle.db,
      {
        unitId: seeded.unitId,
        name: 'Overlapping',
        startDate: draft.startDate,
        endDate: addDays(draft.startDate, 13),
        ruleSetId: draft.ruleSetId,
        ruleSetVersion: draft.ruleSetVersion,
      },
      ACTOR,
    );
    const shift = createAssignment(
      handle.db,
      { periodId: a.id, nurseId: ana!.id, shiftTypeId: day.id, date: addDays(draft.startDate, 3) },
      ACTOR,
    );
    return { draft, day, a, shift };
  }

  it('carries a shift on an overlapping published schedule as locked busy time', () => {
    const { draft, day, a, shift } = overlapping();
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: a.id }, ACTOR));
    const input = loadPeriodInput(handle.db, draft);
    const carried = input.priorAssignments!.filter((r) => r.id === shift.id);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      shiftTypeId: `elsewhere:${day.id}`,
      isLocked: true,
      date: addDays(draft.startDate, 3),
    });
    expect(input.shiftTypes.find((t) => t.id === `elsewhere:${day.id}`)).toMatchObject({
      active: false,
    });
    // Not this draft's own work: the grid and the solver's own rows never see it.
    expect(input.assignments.some((r) => r.id === shift.id)).toBe(false);
  });

  it('keeps a shift on an overlapping schedule as busy time once that schedule is archived', () => {
    const { draft, day, a, shift } = overlapping();
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: a.id }, ACTOR));
    archivePeriod(handle.db, a.id, ACTOR, 'Pay period closed');
    const carried = loadPeriodInput(handle.db, draft).priorAssignments!.filter(
      (r) => r.id === shift.id,
    );
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ shiftTypeId: `elsewhere:${day.id}`, isLocked: true });
  });

  it('leaves another draft on the same unit out of the busy time', () => {
    const { draft, day } = overlapping();
    const input = loadPeriodInput(handle.db, draft);
    expect(input.priorAssignments!.some((r) => r.shiftTypeId === `elsewhere:${day.id}`)).toBe(
      false,
    );
  });
});

describe('a shift the nurse was floated off (D20)', () => {
  const typeOf = (abbreviation: string) =>
    listShiftTypesForUnit(handle.db, seeded.unitId).find((t) => t.abbreviation === abbreviation)!;

  /** Ana's row on `shiftTypeId`/`date` in `periodId`, placed if the seed did not. */
  function anaOn(periodId: string, shiftTypeId: string, date: string) {
    const [ana] = listNursesForUnit(handle.db, seeded.unitId);
    const existing = listAssignmentsForPeriodOnDate(handle.db, periodId, isoDate(date)).find(
      (a) => a.nurseId === ana!.id && a.shiftTypeId === shiftTypeId,
    );
    return (
      existing ??
      createAssignment(
        handle.db,
        { periodId, nurseId: ana!.id, shiftTypeId, date: isoDate(date) },
        ACTOR,
      )
    );
  }

  it('judges a floated shift as her hours, never this unit’s floor', () => {
    const draft = getPeriod(handle.db, seeded.draftPeriodId)!;
    const day = typeOf('D12');
    const row = anaOn(draft.id, day.id, addDays(draft.startDate, 3));
    transact(handle.db, (tx) => markFloatedOff(tx, row.id, '5 East', ACTOR));
    const input = loadPeriodInput(handle.db, draft);
    expect(input.assignments.some((a) => a.id === row.id)).toBe(false);
    const busy = input.priorAssignments!.filter((a) => a.id === row.id);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ shiftTypeId: `floated:${day.id}`, isLocked: true });
    expect(input.shiftTypes.find((t) => t.id === `floated:${day.id}`)).toMatchObject({
      active: false,
      elsewhere: true,
      startTime: '07:00',
      durationHours: 12,
    });
    // The unit's own Day 12 is still there, once, ahead of the copy.
    expect(input.shiftTypes.filter((t) => t.id === day.id)).toHaveLength(1);
  });

  it('carries a shift floated off last period as busy time, not cover', () => {
    const draft = getPeriod(handle.db, seeded.draftPeriodId)!;
    const lastNight = addDays(draft.startDate, -1);
    const before = listPeriodsForUnit(handle.db, seeded.unitId).find(
      (p) => p.status === 'published' && p.endDate === lastNight,
    )!;
    const night = typeOf('N12');
    const row = anaOn(before.id, night.id, lastNight);
    transact(handle.db, (tx) => markFloatedOff(tx, row.id, '5 East', ACTOR));
    const input = loadPeriodInput(handle.db, draft);
    const carried = input.priorAssignments!.filter((a) => a.id === row.id);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({
      shiftTypeId: `floated:${night.id}`,
      date: lastNight,
      isLocked: true,
    });
    expect(input.shiftTypes.find((t) => t.id === `floated:${night.id}`)).toMatchObject({
      active: false,
      elsewhere: true,
    });
  });
});
