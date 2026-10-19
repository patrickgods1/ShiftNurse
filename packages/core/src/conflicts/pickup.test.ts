/**
 * The row a nurse gets when she picks up a shift — by exchange or by answering a call-off. A
 * manager expects charge to land on someone who can carry it and overtime to be flagged only
 * when the pickup itself makes it; these tests pin both.
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Nurse } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { defaultRuleSet } from '../rules/registry.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  solveInputFrom,
} from '../testing/fixtures.js';
import { ConflictEngine } from './engine.js';
import { type PickupRequest, planPickup } from './pickup.js';

const START = isoDate('2026-01-04'); // a Sunday
const END = isoDate('2026-01-17');
const TUE = isoDate('2026-01-06');

/**
 * Plans `request` the way an exchange does: the giver's row (when there is one) is on the schedule
 * the pickup is judged against, and gone from the working list the pickup lands in.
 */
function plan(
  nurses: Nurse[],
  assignments: Assignment[],
  given: Assignment | undefined,
  request: Pick<PickupRequest, 'recipient' | 'date' | 'needsCharge'>,
  options: { ruleSet?: ReturnType<typeof defaultRuleSet> } = {},
) {
  const all = given ? [...assignments, given] : assignments;
  const engine = new ConflictEngine(
    solveInputFrom({
      startDate: START,
      endDate: END,
      nurses,
      assignments: all,
      coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      ...(options.ruleSet ? { ruleSet: options.ruleSet } : {}),
    }),
  );
  return planPickup(engine, engine.baseline(), assignments, engine.input.timeOff, {
    shiftTypeId: DAY_12.id,
    periodId: 'period-1',
    source: 'manual',
    trialId: 'pickup-trial',
    ...request,
  });
}

describe('the row a nurse picking up a shift gets', () => {
  it('gives charge to a recipient who can take it', () => {
    resetFixtureCounters();
    const ida = makeNurse({
      id: 'ida',
      firstName: 'Ida',
      lastName: 'Bell',
      isChargeEligible: true,
    });

    const result = plan([ida], [], undefined, { recipient: ida, date: TUE, needsCharge: true });

    expect(result.row.isCharge).toBe(true);
    expect(result.chargeMovedTo).toBeUndefined();
    expect(result.hard).toEqual([]);
  });

  it('moves charge to the eligible nurse already on the shift when the recipient cannot take it', () => {
    resetFixtureCounters();
    const eli = makeNurse({
      id: 'eli',
      firstName: 'Eli',
      lastName: 'Moss',
      isChargeEligible: true,
    });
    const wes = makeNurse({ id: 'wes', firstName: 'Wes', lastName: 'Tran' });
    const carla = makeNurse({ id: 'carla', isChargeEligible: true });
    const eliRow = assign(eli.id, DAY_12, TUE);
    const carlaRow = assign(carla.id, DAY_12, TUE, { isCharge: true });

    const result = plan([carla, eli, wes], [eliRow], carlaRow, {
      recipient: wes,
      date: TUE,
      needsCharge: true,
    });

    expect(result.row.isCharge).toBe(false);
    expect(result.chargeMovedTo?.nurseId).toBe('eli');
    expect(result.chargeMovedTo?.isCharge).toBe(false); // the row as it stood before the move
    expect(result.assignments.find((a) => a.id === eliRow.id)?.isCharge).toBe(true);
    expect(result.hard).toEqual([]);
  });

  it('picks the most senior eligible nurse to take charge', () => {
    resetFixtureCounters();
    const eli = makeNurse({
      id: 'eli',
      firstName: 'Eli',
      lastName: 'Moss',
      isChargeEligible: true,
      seniorityDate: isoDate('2015-01-01'),
    });
    const ida = makeNurse({
      id: 'ida',
      firstName: 'Ida',
      lastName: 'Bell',
      isChargeEligible: true,
      seniorityDate: isoDate('2010-01-01'),
    });
    const wes = makeNurse({ id: 'wes', firstName: 'Wes', lastName: 'Tran' });

    const result = plan(
      [eli, ida, wes],
      [assign(eli.id, DAY_12, TUE), assign(ida.id, DAY_12, TUE)],
      undefined,
      { recipient: wes, date: TUE, needsCharge: true },
    );

    expect(result.chargeMovedTo?.nurseId).toBe('ida');
  });

  it('never moves charge onto a locked row', () => {
    resetFixtureCounters();
    const eli = makeNurse({
      id: 'eli',
      firstName: 'Eli',
      lastName: 'Moss',
      isChargeEligible: true,
    });
    const wes = makeNurse({ id: 'wes', firstName: 'Wes', lastName: 'Tran' });
    const carla = makeNurse({ id: 'carla', isChargeEligible: true });
    const carlaRow = assign(carla.id, DAY_12, TUE, { isCharge: true });

    const result = plan(
      [carla, eli, wes],
      [assign(eli.id, DAY_12, TUE, { isLocked: true })],
      carlaRow,
      {
        recipient: wes,
        date: TUE,
        needsCharge: true,
      },
    );

    expect(result.row.isCharge).toBe(false);
    expect(result.chargeMovedTo).toBeUndefined();
    expect(result.hard.map((v) => v.code)).toContain('missing_charge_nurse');
  });

  it('starts the recipient at straight time even when the giver was on overtime', () => {
    resetFixtureCounters();
    const gus = makeNurse({ id: 'gus', firstName: 'Gus', lastName: 'Farah' });
    const tia = makeNurse({ id: 'tia', firstName: 'Tia', lastName: 'Lowe' });
    // Gus's Thursday was flagged overtime for him; it says nothing about Tia's week.
    const gusThursday = assign(gus.id, DAY_12, '2026-01-08', { isOvertime: true });
    const rules = defaultRuleSet('unit-1');
    const ruleSet = {
      ...rules,
      configs: rules.configs.map((c) =>
        c.ruleId === 'no-mandatory-overtime' ? { ...c, enabled: true } : c,
      ),
    };

    const result = plan(
      [gus, tia],
      [],
      gusThursday,
      { recipient: tia, date: gusThursday.date, needsCharge: false },
      { ruleSet },
    );

    // Hand: Tia has 0 h that week; one 12 h shift is under the 40 h threshold.
    expect(result.row.isOvertime).toBe(false);
    expect(result.forcedOvertime).toBe(false);
    expect(result.hard).toEqual([]);
  });

  it('flags the pickup as authorised overtime when it takes her past 40 hours', () => {
    resetFixtureCounters();
    const gus = makeNurse({ id: 'gus', firstName: 'Gus', lastName: 'Farah' });
    const tia = makeNurse({ id: 'tia', firstName: 'Tia', lastName: 'Lowe' });
    const tiaWeek = ['2026-01-04', '2026-01-05', '2026-01-06'].map((d) =>
      assign(tia.id, DAY_12, d),
    );
    const gusThursday = assign(gus.id, DAY_12, '2026-01-08');

    const result = plan([gus, tia], tiaWeek, gusThursday, {
      recipient: tia,
      date: gusThursday.date,
      needsCharge: false,
    });

    // Hand: 36 h + 12 h = 48 h, 8 past the 40 h threshold, so straight time is unauthorised
    // overtime; flagged, 48 h is not over the 48 h cap and nothing else breaks.
    expect(result.row.isOvertime).toBe(true);
    expect(result.forcedOvertime).toBe(true);
    expect(result.hard).toEqual([]);
  });

  it('reports a pickup that deepens a cap she is already over', () => {
    resetFixtureCounters();
    const ana = makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz' });
    const ben = makeNurse({ id: 'ben', firstName: 'Ben', lastName: 'Ortiz' });
    // Spaced so no run of consecutive days is what breaks.
    const anaWeek = ['2026-01-04', '2026-01-05', '2026-01-07', '2026-01-08'].map((d) =>
      assign(ana.id, DAY_12, d),
    );
    const benSaturday = assign(ben.id, DAY_12, '2026-01-10');
    const engine = new ConflictEngine(
      solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [ana, ben],
        assignments: [...anaWeek, benSaturday],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 36 } },
      }),
    );
    const before = engine.baseline();

    const result = planPickup(engine, before, anaWeek, engine.input.timeOff, {
      recipient: ana,
      date: benSaturday.date,
      shiftTypeId: DAY_12.id,
      periodId: 'period-1',
      source: 'manual',
      needsCharge: false,
      trialId: 'pickup-trial',
    });

    // Hand: 4 × 12 = 48 h is already 12 over the 36 h cap; a fifth 12 makes 60 h, 24 over.
    const overBefore = before.nurseViolations(ana.id).filter((v) => v.code === 'over_max_hours');
    expect(overBefore.map((v) => v.amount)).toEqual([12]);
    const over = result.hard.filter((v) => v.code === 'over_max_hours');
    expect(over.map((v) => v.amount)).toEqual([24]);
    expect(result.forcedOvertime).toBe(false);
  });

  it('leaves the shift without charge when the only nurse who could take it is locked', () => {
    resetFixtureCounters();
    const eli = makeNurse({
      id: 'eli',
      firstName: 'Eli',
      lastName: 'Moss',
      isChargeEligible: true,
    });
    const bo = makeNurse({ id: 'bo', firstName: 'Bo', lastName: 'Lind' }); // unlocked, not eligible
    const wes = makeNurse({ id: 'wes', firstName: 'Wes', lastName: 'Tran' });
    const carla = makeNurse({ id: 'carla', isChargeEligible: true });
    const carlaRow = assign(carla.id, DAY_12, TUE, { isCharge: true });

    const result = plan(
      [carla, eli, bo, wes],
      [assign(eli.id, DAY_12, TUE, { isLocked: true }), assign(bo.id, DAY_12, TUE)],
      carlaRow,
      { recipient: wes, date: TUE, needsCharge: true },
    );

    // Carla's charge leaves with her; Wes and Bo cannot take it and Eli's row is pinned.
    expect(result.row.isCharge).toBe(false);
    expect(result.chargeMovedTo).toBeUndefined();
    expect(result.assignments.filter((a) => a.isCharge)).toEqual([]);
    expect(result.hard.map((v) => v.code)).toContain('missing_charge_nurse');
  });
});
