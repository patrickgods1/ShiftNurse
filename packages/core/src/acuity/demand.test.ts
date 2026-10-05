/**
 * The nurses a ratio calls for, and the two things a ratio alone misses: a charge nurse who
 * carries no patients is not at the bedside, and a ratio that holds "at all times" must still
 * hold while someone is at lunch. Every expected count below is worked by hand from a 1:5 med-surg
 * ratio (Title 22's) and the shift's length; none is re-derived the way the code derives it.
 */

import { describe, expect, it } from 'vitest';
import type { CoverageRequirement, RatioRule, ShiftType } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  census,
  coverage,
  DAY_8,
  DAY_12,
  MID_8,
  TIER_ROUTINE,
  testAcuityTiers,
  UNIT_ID,
} from '../testing/fixtures.js';
import { type DemandInputs, deriveDemand, type RatioStaffing, type RoleDemand } from './demand.js';

const DATE = isoDate('2026-01-06');

const RN_1_TO_5: RatioRule = {
  id: 'ratio-rn',
  unitId: UNIT_ID,
  role: 'RN',
  acuityTierId: null,
  maxPatientsPerNurse: 5,
  active: true,
};
const CNA_1_TO_10: RatioRule = {
  ...RN_1_TO_5,
  id: 'ratio-cna',
  role: 'CNA',
  maxPatientsPerNurse: 10,
};

function demandFor(
  shiftType: ShiftType,
  patients: number,
  ratioStaffing?: RatioStaffing,
  extra: Partial<DemandInputs> = {},
): Record<'RN' | 'LPN' | 'CNA', RoleDemand> {
  const inputs: DemandInputs = {
    shiftTypes: [DAY_12, DAY_8, MID_8].includes(shiftType) ? [DAY_12, DAY_8, MID_8] : [shiftType],
    acuityTiers: testAcuityTiers,
    ratioRules: [RN_1_TO_5],
    coverageRequirements: [],
    censusForecasts: patients > 0 ? [census(DATE, shiftType, { [TIER_ROUTINE.id]: patients })] : [],
    ...(ratioStaffing ? { ratioStaffing } : {}),
    ...extra,
  };
  const row = deriveDemand([DATE], inputs).get(DATE, shiftType.id);
  if (!row) throw new Error('no demand row');
  return row.byRole;
}

const NO_PATIENTS_FOR_CHARGE: RatioStaffing = {
  chargeNurseTakesPatients: false,
  breakMinutesPerNurse: 0,
  chargeCoversBreaks: false,
};

describe('a charge nurse and the ratio', () => {
  it('counts the charge nurse at the bedside when the unit says nothing, as before', () => {
    // 20 patients at 1:5 is four RNs, one of whom is charge.
    const rn = demandFor(DAY_12, 20).RN;
    expect(rn.ratioDerived).toBe(4);
    expect(rn.minCount).toBe(4);
    expect(rn.chargeWithoutPatients).toBe(0);
    expect(rn.breakRelief).toBe(0);
  });

  it('adds a fifth RN to 20 patients when the charge nurse takes none', () => {
    const rn = demandFor(DAY_12, 20, NO_PATIENTS_FOR_CHARGE).RN;
    expect(rn.ratioBedside).toBe(4);
    expect(rn.chargeWithoutPatients).toBe(1);
    expect(rn.ratioDerived).toBe(5);
    expect(rn.minCount).toBe(5);
  });

  it('adds no charge nurse to a mid shift, which works under the day shift’s charge', () => {
    const rn = demandFor(MID_8, 20, NO_PATIENTS_FOR_CHARGE).RN;
    expect(rn.chargeWithoutPatients).toBe(0);
    expect(rn.ratioDerived).toBe(4);
  });

  it('asks nothing extra of a shift with no census, where only the floor applies', () => {
    const rn = demandFor(DAY_12, 0, NO_PATIENTS_FOR_CHARGE).RN;
    expect(rn.ratioDerived).toBe(0);
    expect(rn.chargeWithoutPatients).toBe(0);
  });

  it('adds no charge nurse to a nursing-assistant ratio', () => {
    const cna = demandFor(DAY_12, 20, NO_PATIENTS_FOR_CHARGE, {
      ratioRules: [RN_1_TO_5, CNA_1_TO_10],
    }).CNA;
    expect(cna.ratioDerived).toBe(2);
    expect(cna.chargeWithoutPatients).toBe(0);
  });

  it('still lets a higher coverage floor bind above the ratio and the charge nurse', () => {
    const floor: CoverageRequirement[] = [coverage(DAY_12, 'RN', 6, 6, null, DATE)];
    const rn = demandFor(DAY_12, 20, NO_PATIENTS_FOR_CHARGE, { coverageRequirements: floor }).RN;
    expect(rn.ratioDerived).toBe(5);
    expect(rn.minCount).toBe(6);
    expect(rn.bindingConstraint).toBe('coverage_floor');
  });
});

describe('break relief, so the ratio holds while nurses are at lunch', () => {
  // A 12-hour shift is 720 minutes; with no breaks in its first or last hour, breaks fit in 600.
  const lunch = (chargeCoversBreaks: boolean, chargeNurseTakesPatients = false): RatioStaffing => ({
    chargeNurseTakesPatients,
    breakMinutesPerNurse: 60,
    chargeCoversBreaks,
  });

  it('needs one relief nurse for five bedside RNs taking an hour each on a 12', () => {
    // 25 patients at 1:5 = 5 bedside RNs; 5 × 60 = 300 break minutes in a 600-minute window.
    const rn = demandFor(DAY_12, 25, lunch(false)).RN;
    expect(rn.ratioBedside).toBe(5);
    expect(rn.breakRelief).toBe(1);
    expect(rn.ratioDerived).toBe(5 + 1 + 1);
  });

  it('still needs only one for nine bedside RNs, whose 540 break minutes fit in 600', () => {
    const rn = demandFor(DAY_12, 45, lunch(false)).RN;
    expect(rn.ratioBedside).toBe(9);
    expect(rn.breakRelief).toBe(1);
  });

  it('needs two for eleven, whose 660 break minutes do not fit one relief nurse’s 600', () => {
    const rn = demandFor(DAY_12, 55, lunch(false)).RN;
    expect(rn.ratioBedside).toBe(11);
    expect(rn.breakRelief).toBe(2);
    expect(rn.ratioDerived).toBe(11 + 1 + 2);
  });

  it('lets a charge nurse without patients cover one relief, as Title 22 allows', () => {
    expect(demandFor(DAY_12, 25, lunch(true)).RN.breakRelief).toBe(0);
    expect(demandFor(DAY_12, 45, lunch(true)).RN.breakRelief).toBe(0);
    expect(demandFor(DAY_12, 55, lunch(true)).RN.breakRelief).toBe(1);
  });

  it('does not let a charge nurse who has patients of her own cover breaks', () => {
    const rn = demandFor(DAY_12, 25, lunch(true, true)).RN;
    expect(rn.chargeWithoutPatients).toBe(0);
    expect(rn.breakRelief).toBe(1);
    expect(rn.ratioDerived).toBe(5 + 1);
  });

  it('fits breaks into the 360 minutes of an 8-hour shift', () => {
    // 30 patients at 1:5 = 6 bedside RNs; 6 × 30 = 180 minutes in 480 − 120 = 360.
    const rn = demandFor(DAY_8, 30, {
      chargeNurseTakesPatients: true,
      breakMinutesPerNurse: 30,
      chargeCoversBreaks: false,
    }).RN;
    expect(rn.breakRelief).toBe(1);
    expect(rn.ratioDerived).toBe(7);
  });

  it('relieves nursing assistants under their own ratio too, without a charge nurse', () => {
    // 20 patients at 1:10 = 2 assistants; 120 break minutes in 600 = one relief.
    const cna = demandFor(DAY_12, 20, lunch(true), { ratioRules: [RN_1_TO_5, CNA_1_TO_10] }).CNA;
    expect(cna.breakRelief).toBe(1);
    expect(cna.ratioDerived).toBe(3);
  });
});

describe('a licensed-nurse ratio that pools RNs and LVNs', () => {
  // Title 22 counts licensed nurses: RNs and LVNs together, LVNs at most half.
  const LICENSED_1_TO_5: RatioRule = {
    id: 'ratio-licensed',
    unitId: UNIT_ID,
    role: 'licensed',
    acuityTierId: null,
    maxPatientsPerNurse: 5,
    minRnShare: 0.5,
    active: true,
  };

  function licensed(patients: number, staffing?: RatioStaffing) {
    const row = deriveDemand([DATE], {
      shiftTypes: [DAY_12],
      acuityTiers: testAcuityTiers,
      ratioRules: [LICENSED_1_TO_5],
      coverageRequirements: [],
      censusForecasts: [census(DATE, DAY_12, { [TIER_ROUTINE.id]: patients })],
      ...(staffing ? { ratioStaffing: staffing } : {}),
    }).get(DATE, DAY_12.id)!;
    return row;
  }

  it('asks for four licensed nurses for 20 patients, at least two of them RNs', () => {
    const row = licensed(20);
    expect(row.licensed).toMatchObject({ ratioBedside: 4, ratioDerived: 4, minRn: 2 });
    // The RNs the share needs are the RN minimum Generate aims for; LVNs are not forced.
    expect(row.byRole.RN.minCount).toBe(2);
    expect(row.byRole.LPN.minCount).toBe(0);
  });

  it('rounds the RN share up: five licensed at half is three RNs', () => {
    const row = licensed(25);
    expect(row.licensed).toMatchObject({ ratioDerived: 5, minRn: 3 });
  });

  it('adds the charge nurse kept free of patients to the licensed count', () => {
    const row = licensed(20, {
      chargeNurseTakesPatients: false,
      breakMinutesPerNurse: 0,
      chargeCoversBreaks: false,
    });
    // 4 at the bedside + the charge RN = 5 licensed; half of 5, rounded up, is 3 RNs.
    expect(row.licensed).toMatchObject({
      ratioBedside: 4,
      chargeWithoutPatients: 1,
      ratioDerived: 5,
      minRn: 3,
    });
  });

  it('reads an RN short of the share as a ratio shortfall, though a lower floor exists', () => {
    // An RN floor of 1 and a share of 2 RNs: the share binds, and it is the ratio.
    const row = deriveDemand([DATE], {
      shiftTypes: [DAY_12],
      acuityTiers: testAcuityTiers,
      ratioRules: [LICENSED_1_TO_5],
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, DATE)],
      censusForecasts: [census(DATE, DAY_12, { [TIER_ROUTINE.id]: 20 })],
    }).get(DATE, DAY_12.id)!;
    expect(row.byRole.RN).toMatchObject({ minCount: 2, bindingConstraint: 'ratio' });
  });

  it('asks nothing pooled of a unit without a licensed rule', () => {
    expect(demandFor(DAY_12, 20).RN.minCount).toBe(4);
    const row = deriveDemand([DATE], {
      shiftTypes: [DAY_12],
      acuityTiers: testAcuityTiers,
      ratioRules: [RN_1_TO_5],
      coverageRequirements: [],
      censusForecasts: [census(DATE, DAY_12, { [TIER_ROUTINE.id]: 20 })],
    }).get(DATE, DAY_12.id)!;
    expect(row.licensed).toBeUndefined();
  });
});
