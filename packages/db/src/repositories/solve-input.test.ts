/**
 * `loadPeriodInput` is the one definition of "the period" that Generate, the conflict detector,
 * costing and the benchmark all share. What it gets wrong, every one of them gets wrong the same
 * way — so its unit boundaries are tested here directly: another unit's nurses, rates and
 * shifts must never leak into a solve, and the rates a solve prices with must be exactly the
 * ones the cost screen would resolve.
 */

import { addDays, defaultRuleSet, isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { seedScenarioUnit } from '../seed/scenarios.js';
import type { SeedResult } from '../seed/types.js';
import { createRatioRule, listActiveRatioRulesForUnit, updateRatioRule } from './acuity.js';
import {
  createShiftType,
  createUnit,
  getUnit,
  listShiftTypesForUnit,
  updateUnit,
} from './config.js';
import { createIncompatibilityGroup } from './incompatibility.js';
import { createNurseUnit } from './nurse-units.js';
import { createOvertimeVolunteer } from './overtime-volunteers.js';
import { createPayRate, listPayRatesForUnit, savePaySettings } from './pay.js';
import { createPreceptorship } from './preceptorships.js';
import { createNurse, listNursesForUnit } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, getPeriod, updatePeriodStatus } from './schedule.js';
import { costContext, loadPeriodInput, timeOffForPeriod, timeOffWindow } from './solve-input.js';
import { createTimeOffRequest, listTimeOffForUnit } from './timeoff.js';

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
      { callBackMinimumHours: 0, premiumStacking: 'additive' },
      ACTOR,
    );
    expect(costContext(handle.db, unitId, ruleSet).premiumStacking).toBe('additive');
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
      updateRatioRule(tx, rule.id, { minRnShare: null }, ACTOR),
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

  it('counts a draft on 5 West as busy time, but not a period archived there', () => {
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
    place(old.id, addDays(period.startDate, 1));
    updatePeriodStatus(handle.db, old.id, 'archived', ACTOR);
    const busy = loadPeriodInput(handle.db, period).priorAssignments!.filter((a) =>
      a.shiftTypeId.startsWith('elsewhere:'),
    );
    expect(busy.map((a) => a.id)).toEqual([planned.id]);
  });

  it('puts nurses floated in from 5 West after the home roster, with their own credentials', () => {
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
    const input = loadPeriodInput(handle.db, period);
    expect(input.nurses).toEqual(listNursesForUnit(handle.db, seeded.unitId));
    expect(input.shiftTypes.every((t) => !t.id.startsWith('elsewhere:'))).toBe(true);
    expect(input.priorAssignments!.every((a) => !a.shiftTypeId.startsWith('elsewhere:'))).toBe(
      true,
    );
  });
});
