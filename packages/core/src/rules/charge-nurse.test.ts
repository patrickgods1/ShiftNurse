import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => resetFixtureCounters());

const ana = () =>
  makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Diaz', isChargeEligible: true });
const bo = () => makeNurse({ id: 'bo', firstName: 'Bo', lastName: 'Park', isChargeEligible: true });
const lena = () =>
  makeNurse({
    id: 'lena',
    firstName: 'Lena',
    lastName: 'Ortiz',
    role: 'LPN',
    isChargeEligible: true,
  });

/** One day shift on Monday 5 January, needing one RN, judged by the coverage rule alone. */
function judge(
  nurses: Nurse[],
  assignments: Assignment[],
  ruleParams?: Record<string, Record<string, unknown>>,
) {
  const s = scenario({
    startDate: isoDate('2026-01-05'),
    endDate: isoDate('2026-01-05'),
    nurses,
    coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1),
    assignments,
    ...(ruleParams ? { ruleParams } : {}),
  });
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx, { only: ['coverage-minimums'] }).violations;
}

describe('who runs the shift', () => {
  it('flags a shift with two charge nurses', () => {
    const found = judge(
      [ana(), bo()],
      [
        assign('ana', DAY_12, '2026-01-05', { isCharge: true }),
        assign('bo', DAY_12, '2026-01-05', { isCharge: true }),
      ],
    );
    const double = found.filter((v) => v.code === 'multiple_charge_nurses');
    expect(double).toHaveLength(1);
    // Two marked charge where one runs the shift: one too many.
    expect(double[0]!.details?.chargeCount).toBe(2);
    expect(double[0]!.amount).toBe(1);
    expect(found.some((v) => v.code === 'missing_charge_nurse')).toBe(false);
  });

  it('does not let an LPN run the shift when the charge nurse must be an RN', () => {
    const found = judge(
      [lena(), ana()],
      [
        assign('lena', DAY_12, '2026-01-05', { isCharge: true }),
        assign('ana', DAY_12, '2026-01-05'),
      ],
    );
    const missing = found.filter((v) => v.code === 'missing_charge_nurse');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain('Lena');
    expect(missing[0]!.message).toContain('is not an RN');
    expect(missing[0]!.details?.flaggedNurseIds).toEqual(['lena']);
  });

  it('lets a charge-eligible LPN run the shift where the unit allows it', () => {
    const found = judge(
      [lena(), ana()],
      [
        assign('lena', DAY_12, '2026-01-05', { isCharge: true }),
        assign('ana', DAY_12, '2026-01-05'),
      ],
      { 'coverage-minimums': { chargeMustBeRN: false } },
    );
    expect(found).toEqual([]);
  });

  it('accepts one RN in charge', () => {
    const found = judge(
      [ana(), bo()],
      [assign('ana', DAY_12, '2026-01-05', { isCharge: true }), assign('bo', DAY_12, '2026-01-05')],
    );
    expect(found).toEqual([]);
  });

  it('says why an RN who is not charge-eligible cannot run the shift', () => {
    const cy = makeNurse({ id: 'cy', firstName: 'Cy', lastName: 'Moss' });
    const found = judge(
      [cy, ana()],
      [assign('cy', DAY_12, '2026-01-05', { isCharge: true }), assign('ana', DAY_12, '2026-01-05')],
    );
    const missing = found.filter((v) => v.code === 'missing_charge_nurse');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain('Cy Moss is marked charge but is not charge-eligible');
  });

  it('names both LPNs marked charge, and that neither is an RN', () => {
    const lou = makeNurse({
      id: 'lou',
      firstName: 'Lou',
      lastName: 'Reyes',
      role: 'LPN',
      isChargeEligible: true,
    });
    const found = judge(
      [lena(), lou],
      [
        assign('lena', DAY_12, '2026-01-05', { isCharge: true }),
        assign('lou', DAY_12, '2026-01-05', { isCharge: true }),
      ],
    );
    const missing = found.filter((v) => v.code === 'missing_charge_nurse');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.message).toContain(
      'Lena Ortiz and Lou Reyes are marked charge but are not RNs',
    );
    // Two marked charge is a breach whoever they are: one too many.
    const double = found.filter((v) => v.code === 'multiple_charge_nurses');
    expect(double).toHaveLength(1);
    expect(double[0]!.amount).toBe(1);
  });

  it('names the two nurses marked charge on a doubled-up shift', () => {
    const found = judge(
      [ana(), bo()],
      [
        assign('ana', DAY_12, '2026-01-05', { isCharge: true }),
        assign('bo', DAY_12, '2026-01-05', { isCharge: true }),
      ],
    );
    const double = found.find((v) => v.code === 'multiple_charge_nurses');
    expect(double?.message).toBe(
      'Day 12 on Mon Jan 5 has 2 nurses marked charge (Ana Diaz and Bo Park); one runs the shift.',
    );
  });

  it('flags three marked charge with nobody able to run the shift as both breaches', () => {
    // Lena (LPN), Lou (LPN) and Cy (RN, not charge-eligible) all marked charge: nobody may take
    // charge (missing, amount 1) and three flags where one belongs (two too many, amount 2).
    const lou = makeNurse({
      id: 'lou',
      firstName: 'Lou',
      lastName: 'Reyes',
      role: 'LPN',
      isChargeEligible: true,
    });
    const cy = makeNurse({ id: 'cy', firstName: 'Cy', lastName: 'Moss' });
    const found = judge(
      [lena(), lou, cy],
      [
        assign('lena', DAY_12, '2026-01-05', { isCharge: true }),
        assign('lou', DAY_12, '2026-01-05', { isCharge: true }),
        assign('cy', DAY_12, '2026-01-05', { isCharge: true }),
      ],
    );
    const missing = found.filter((v) => v.code === 'missing_charge_nurse');
    const double = found.filter((v) => v.code === 'multiple_charge_nurses');
    expect(missing.map((v) => v.amount)).toEqual([1]);
    expect(missing[0]!.message).toContain(
      'Lena Ortiz, Lou Reyes and Cy Moss are marked charge but none is a charge-eligible RN',
    );
    expect(double.map((v) => v.amount)).toEqual([2]);
    expect(double[0]!.details?.chargeCount).toBe(3);
  });
});
