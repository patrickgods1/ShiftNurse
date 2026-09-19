/**
 * A manager records a trade or a giveaway on a nurse's behalf; these tests check the verdict
 * a nurse manager would expect from each: a rest-breaking trade is refused outright, a
 * legitimate swap sails through, and a pickup that quietly creates overtime or piles a third
 * weekend onto the same nurse comes back with a warning and the numbers behind it.
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Id } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  census,
  coverageAllWeek,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  solveInputFrom,
  TIER_ROUTINE,
} from '../testing/fixtures.js';
import { evaluateExchange, planExchange } from './evaluate.js';
import type { ExchangeInput, ExchangeProposal } from './types.js';

const START = isoDate('2026-01-04'); // a Sunday
const END = isoDate('2026-01-17');

function trade(offered: Assignment, requested: Assignment, counterpartyId: Id): ExchangeProposal {
  return {
    kind: 'trade',
    requestingNurseId: offered.nurseId,
    counterpartyNurseId: counterpartyId,
    offeredAssignmentId: offered.id,
    requestedAssignmentId: requested.id,
  };
}

function giveaway(offered: Assignment, counterpartyId: Id): ExchangeProposal {
  return {
    kind: 'giveaway',
    requestingNurseId: offered.nurseId,
    counterpartyNurseId: counterpartyId,
    offeredAssignmentId: offered.id,
  };
}

describe('evaluateExchange', () => {
  it('refuses a trade that leaves the nurse with no rest between a night and a day', () => {
    resetFixtureCounters();
    const aisha = makeNurse({ firstName: 'Aisha', lastName: 'Haddad' });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Ortiz' });

    // Aisha already works Friday night; it ends 07:00 Saturday.
    const fridayNight = assign(aisha.id, NIGHT_12, '2026-01-09');
    // The shift Aisha gives away is unrelated (mid-week), so it isn't what creates the conflict.
    const midweekGiveaway = assign(aisha.id, DAY_12, '2026-01-07');
    // Ben's Saturday day shift starts at 07:00 — exactly when Aisha's Friday night ends.
    const saturdayDay = assign(ben.id, DAY_12, '2026-01-10');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [aisha, ben],
        assignments: [fridayNight, midweekGiveaway, saturdayDay],
      }),
      proposal: trade(midweekGiveaway, saturdayDay, ben.id),
    };

    const result = evaluateExchange(input);

    expect(result.verdict).toBe('blocked');
    expect(result.blockers.length).toBeGreaterThan(0);
    const blocker = result.blockers.find((b) => /minimum rest/i.test(b));
    expect(blocker).toBeDefined();
    expect(blocker).toContain('Aisha Haddad');
  });

  it('a legal trade between two day shifts is ok with no warnings', () => {
    resetFixtureCounters();
    const priya = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const tom = makeNurse({ firstName: 'Tom', lastName: 'Reed' });

    const priyaTuesday = assign(priya.id, DAY_12, '2026-01-06');
    const tomThursday = assign(tom.id, DAY_12, '2026-01-08');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [priya, tom],
        assignments: [priyaTuesday, tomThursday],
      }),
      proposal: trade(priyaTuesday, tomThursday, tom.id),
    };

    const result = evaluateExchange(input);

    expect(result.verdict).toBe('ok');
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('a giveaway that pushes the pickup nurse past 40 hours warns about overtime and prices it', () => {
    resetFixtureCounters();
    const receiver = makeNurse({ firstName: 'Ronda', lastName: 'Kim' });
    const giver = makeNurse({ firstName: 'Gus', lastName: 'Farah' });

    // Ronda already works Sun/Mon/Tue this work week — 36 straight-time hours.
    const already = [
      assign(receiver.id, DAY_12, '2026-01-04'),
      assign(receiver.id, DAY_12, '2026-01-05'),
      assign(receiver.id, DAY_12, '2026-01-06'),
    ];
    // Gus gives away his Wednesday shift, the same week, same rate, no differentials.
    const wednesday = assign(giver.id, DAY_12, '2026-01-07');

    const rate = 50;
    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [receiver, giver],
        assignments: [...already, wednesday],
        cost: {
          payRates: [payRate(rate, { role: 'RN' })],
          differentials: [],
          overtimeRules: [overtimeRule('weekly', 40, 1.5)],
        },
      }),
      proposal: giveaway(wednesday, receiver.id),
    };

    const result = evaluateExchange(input);

    // Hand computation: Ronda's week goes from 36h to 48h. The weekly-overtime rule attributes
    // over = after - max(threshold, before) = 48 - max(40, 36) = 8h of overtime to the picked-up
    // shift. Gus's $600 (12h × $50) leaves the unit and the identical $600 base returns on
    // Ronda's side — they cancel at the same rate — leaving only the overtime premium:
    // 8h × (1.5 − 1) × $50 = $200.
    expect(result.verdict).toBe('warn');
    expect(result.warnings.some((w) => /overtime/i.test(w))).toBe(true);
    expect(result.cost.delta).toBeCloseTo(200, 6);

    // planExchange must have authorised the pickup, or the rule would have blocked it outright.
    const plan = planExchange(input);
    const created = plan.create.find((a) => a.nurseId === receiver.id);
    expect(created?.isOvertime).toBe(true);
  });

  it('a giveaway that hands a third straight weekend to the same nurse warns on fairness', () => {
    resetFixtureCounters();
    const a = makeNurse({ firstName: 'Nina', lastName: 'Alvarez' });
    const b = makeNurse({ firstName: 'Omar', lastName: 'Said' });
    const c = makeNurse({ firstName: 'Kai', lastName: 'Chen' });
    const d = makeNurse({ firstName: 'Deja', lastName: 'Brooks' });

    // Every nurse already carries exactly one weekend shift, evenly sharing the burden.
    const aWeekend = assign(a.id, DAY_12, '2026-01-11'); // Sunday, weekend window starting Sat 10
    const bWeekend = assign(b.id, DAY_12, '2026-01-11');
    const cWeekend = assign(c.id, DAY_12, '2026-01-11');
    // Deja's weekend shift falls on a *different* weekend window, so giving it to Nina adds a
    // second, distinct weekend to her count rather than doubling up on the one she already has.
    const dWeekend = assign(d.id, DAY_12, '2026-01-17'); // Saturday, the following weekend window

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [a, b, c, d],
        assignments: [aWeekend, bWeekend, cWeekend, dWeekend],
      }),
      proposal: giveaway(dWeekend, a.id),
    };

    const result = evaluateExchange(input);

    expect(result.verdict).toBe('warn');
    expect(result.fairness.delta).toBeLessThan(-0.5);
    expect(result.warnings.some((w) => /fairness/i.test(w))).toBe(true);
  });

  it('an LPN cannot pick up the only RN shift on a ratio-bound night', () => {
    resetFixtureCounters();
    const rn = makeNurse({ firstName: 'Rita', lastName: 'Nolan', role: 'RN' });
    const lpn = makeNurse({ firstName: 'Leo', lastName: 'Park', role: 'LPN' });

    const theShift = assign(rn.id, NIGHT_12, '2026-01-08');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [rn, lpn],
        assignments: [theShift],
        // A modest census on a routine (1:5) tier derives a hard minimum of one RN.
        censusForecasts: [census('2026-01-08', NIGHT_12, { [TIER_ROUTINE.id]: 3 })],
      }),
      proposal: giveaway(theShift, lpn.id),
    };

    const result = evaluateExchange(input);

    expect(result.verdict).toBe('blocked');
    expect(result.shiftViolationsIntroduced.some((v) => v.code === 'ratio_breach')).toBe(true);
  });

  it("trading away the shift's only charge nurse is blocked", () => {
    resetFixtureCounters();
    const chargeNurse = makeNurse({
      firstName: 'Carla',
      lastName: 'Diaz',
      isChargeEligible: true,
    });
    const pickup = makeNurse({ firstName: 'Wes', lastName: 'Tran' }); // not charge-eligible

    const theShift = assign(chargeNurse.id, DAY_12, '2026-01-06', { isCharge: true });

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [chargeNurse, pickup],
        assignments: [theShift],
        // A floor > 0 is what makes the coverage rule's charge-nurse check apply at all.
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      }),
      proposal: giveaway(theShift, pickup.id),
    };

    const result = evaluateExchange(input);

    expect(result.verdict).toBe('blocked');
    expect(result.shiftViolationsIntroduced.some((v) => v.code === 'missing_charge_nurse')).toBe(
      true,
    );
  });

  it('refuses to move a locked shift', () => {
    resetFixtureCounters();
    const holder = makeNurse({ firstName: 'Lena', lastName: 'Voss' });
    const other = makeNurse({ firstName: 'Sam', lastName: 'Ito' });
    const lockedShift = assign(holder.id, DAY_12, '2026-01-06', { isLocked: true });

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [holder, other],
        assignments: [lockedShift],
      }),
      proposal: giveaway(lockedShift, other.id),
    };

    expect(() => evaluateExchange(input)).toThrow(/locked/i);
    expect(() => planExchange(input)).toThrow(/locked/i);
  });

  it('a giveaway with a requested assignment is malformed', () => {
    resetFixtureCounters();
    const giver = makeNurse({ firstName: 'Amy', lastName: 'Wu' });
    const recipient = makeNurse({ firstName: 'Nate', lastName: 'Cole' });
    const offered = assign(giver.id, DAY_12, '2026-01-06');
    const someOtherAssignment = assign(recipient.id, DAY_12, '2026-01-08');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [giver, recipient],
        assignments: [offered, someOtherAssignment],
      }),
      proposal: {
        kind: 'giveaway',
        requestingNurseId: giver.id,
        counterpartyNurseId: recipient.id,
        offeredAssignmentId: offered.id,
        requestedAssignmentId: someOtherAssignment.id,
      },
    };

    expect(() => evaluateExchange(input)).toThrow(/giveaway/i);
  });

  it('planExchange carries charge and notes across and swaps the nurse ids', () => {
    resetFixtureCounters();
    const alice = makeNurse({ firstName: 'Alice', lastName: 'Kwan' });
    const bo = makeNurse({ firstName: 'Bo', lastName: 'Lindqvist' });

    const aliceShift = assign(alice.id, DAY_12, '2026-01-06', {
      isCharge: true,
      notes: 'call ahead',
    });
    const boShift = assign(bo.id, DAY_12, '2026-01-08', {
      isCharge: false,
      notes: 'bring badge',
    });

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [alice, bo],
        assignments: [aliceShift, boShift],
      }),
      proposal: trade(aliceShift, boShift, bo.id),
    };

    const plan = planExchange(input);

    expect(plan.remove.sort()).toEqual([aliceShift.id, boShift.id].sort());
    expect(plan.create).toHaveLength(2);

    const boGetsAlicesShift = plan.create.find(
      (a) => a.nurseId === bo.id && a.shiftTypeId === DAY_12.id && a.date === aliceShift.date,
    );
    expect(boGetsAlicesShift).toMatchObject({ isCharge: true, notes: 'call ahead' });

    const aliceGetsBosShift = plan.create.find(
      (a) => a.nurseId === alice.id && a.shiftTypeId === DAY_12.id && a.date === boShift.date,
    );
    expect(aliceGetsBosShift).toMatchObject({ isCharge: false, notes: 'bring badge' });
  });

  it('evaluating twice on the same input yields identical output', () => {
    resetFixtureCounters();
    const priya = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const tom = makeNurse({ firstName: 'Tom', lastName: 'Reed' });
    const priyaTuesday = assign(priya.id, DAY_12, '2026-01-06');
    const tomThursday = assign(tom.id, DAY_12, '2026-01-08');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [priya, tom],
        assignments: [priyaTuesday, tomThursday],
        cost: {
          payRates: [payRate(45, { role: 'RN' })],
          differentials: [differential('weekend', 'flat', 3)],
          overtimeRules: [overtimeRule('weekly', 40, 1.5)],
        },
      }),
      proposal: trade(priyaTuesday, tomThursday, tom.id),
    };

    const first = evaluateExchange(input);
    const second = evaluateExchange(input);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
