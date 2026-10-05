/**
 * `loadPeriodInput` is the one definition of "the period" that Generate, the conflict detector,
 * costing and the benchmark all share. What it gets wrong, every one of them gets wrong the same
 * way — so its unit boundaries are tested here directly: another unit's nurses, rates and
 * shifts must never leak into a solve, and the rates a solve prices with must be exactly the
 * ones the cost screen would resolve.
 */

import { addDays, isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { seedScenarioUnit } from '../seed/scenarios.js';
import type { SeedResult } from '../seed/types.js';
import { createRatioRule, listActiveRatioRulesForUnit, updateRatioRule } from './acuity.js';
import { createUnit, getUnit, listShiftTypesForUnit, updateUnit } from './config.js';
import { createIncompatibilityGroup } from './incompatibility.js';
import { createOvertimeVolunteer } from './overtime-volunteers.js';
import { createPayRate, listPayRatesForUnit } from './pay.js';
import { createNurse, listNursesForUnit } from './roster.js';
import { getPeriod } from './schedule.js';
import { loadPeriodInput, timeOffForPeriod, timeOffWindow } from './solve-input.js';
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
    const inTail = offer(addDays(period.startDate, -14), addDays(period.startDate, -14));
    const inPeriod = offer(period.startDate, period.endDate);
    offer(addDays(period.startDate, -20), addDays(period.startDate, -15));
    offer(addDays(period.endDate, 1), addDays(period.endDate, 3));
    const input = loadPeriodInput(handle.db, period);
    expect(input.overtimeVolunteers!.map((v) => v.id)).toEqual([inTail.id, inPeriod.id]);
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

describe('the leave a period reads', () => {
  const march = { startDate: isoDate('2026-03-01'), endDate: isoDate('2026-03-14') };

  it('reaches back a lookback and a pay period, and forward a pay period', () => {
    // 14-day pay period: 03-01 less (14 + 14) days is 02-01; 03-14 plus 14 days is 03-28.
    expect(timeOffWindow({ payPeriodDays: 14 }, march)).toEqual({
      start: '2026-02-01',
      end: '2026-03-28',
    });
  });

  it('never shrinks the slack below a work week on a short pay period', () => {
    // 7-day pay period: 03-01 less (14 + 7) is 02-08; 03-14 plus 7 is 03-21.
    expect(timeOffWindow({ payPeriodDays: 7 }, march)).toEqual({
      start: '2026-02-08',
      end: '2026-03-21',
    });
    // A 5-day one still gets 7: 03-01 less 21 and 03-14 plus 7.
    expect(timeOffWindow({ payPeriodDays: 5 }, march)).toEqual({
      start: '2026-02-08',
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
    const endedBefore = ask('2026-01-25', '2026-01-31');
    const endsOnStart = ask('2026-01-25', '2026-02-01');
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
