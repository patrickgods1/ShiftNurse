/**
 * `loadPeriodInput` is the one definition of "the period" that Generate, the conflict detector,
 * costing and the benchmark all share. What it gets wrong, every one of them gets wrong the same
 * way — so its unit boundaries are tested here directly: another unit's nurses, rates and
 * shifts must never leak into a solve, and the rates a solve prices with must be exactly the
 * ones the cost screen would resolve.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { type SeedResult, seedDemoUnit } from '../seed/demo.js';
import { createUnit, listShiftTypesForUnit } from './config.js';
import { createPayRate, listPayRatesForUnit } from './pay.js';
import { createNurse, listNursesForUnit } from './roster.js';
import { getPeriod } from './schedule.js';
import { loadPeriodInput } from './solve-input.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let seeded: SeedResult;

beforeEach(() => {
  handle = openTestDatabase();
  seeded = transact(handle.db, (tx) =>
    seedDemoUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 2 }),
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
