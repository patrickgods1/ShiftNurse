/**
 * A manager records a trade or a giveaway on a nurse's behalf; these tests check the verdict
 * a nurse manager would expect from each: a rest-breaking trade is refused outright, a
 * legitimate swap sails through, and a pickup that quietly creates overtime or piles a third
 * weekend onto the same nurse comes back with a warning and the numbers behind it.
 */

import { describe, expect, it } from 'vitest';
import type { Assignment, Id } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { defaultRuleSet } from '../rules/registry.js';
import { floatedOff } from '../schedule/elsewhere.js';
import {
  assign,
  census,
  coverageAllWeek,
  DAY_8,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  ON_CALL,
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
    expect(blocker).toEqual(expect.stringContaining('Aisha Haddad'));
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

  it("does not call standby overtime in a trade's warning", () => {
    resetFixtureCounters();
    const receiver = makeNurse({ firstName: 'Ronda', lastName: 'Kim' });
    const giver = makeNurse({ firstName: 'Gus', lastName: 'Farah' });

    // Ronda works Sun/Mon/Tue (36h) and is on call Thursday night (12h standby, not worked).
    const already = [
      assign(receiver.id, DAY_12, '2026-01-04'),
      assign(receiver.id, DAY_12, '2026-01-05'),
      assign(receiver.id, DAY_12, '2026-01-06'),
      assign(receiver.id, ON_CALL, '2026-01-08'),
    ];
    const wednesday = assign(giver.id, DAY_8, '2026-01-07');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [receiver, giver],
        assignments: [...already, wednesday],
        cost: {
          payRates: [payRate(50, { role: 'RN' })],
          differentials: [],
          overtimeRules: [overtimeRule('weekly', 40, 1.5)],
        },
      }),
      proposal: giveaway(wednesday, receiver.id),
    };

    // Hand: 36 + 8 = 44 worked hours, 4 past 40. Counting the standby would make it 56, so 16.
    const result = evaluateExchange(input);
    expect(result.warnings).toContainEqual(expect.stringMatching(/^Creates 4 hours of overtime/));
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

    expect(() => evaluateExchange(input)).toThrow(
      'That shift is locked; unlock it before proposing an exchange that moves it.',
    );
    expect(() => planExchange(input)).toThrow(/locked/i);
  });

  it('names the nurses, not their ids, when the shift belongs to someone else', () => {
    resetFixtureCounters();
    const ann = makeNurse({ firstName: 'Ann', lastName: 'Lee' });
    const bea = makeNurse({ firstName: 'Bea', lastName: 'Ng' });
    const cy = makeNurse({ firstName: 'Cy', lastName: 'Ode' });
    const beasShift = assign(bea.id, DAY_12, '2026-01-06');
    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [ann, bea, cy],
        assignments: [beasShift],
      }),
      proposal: { ...giveaway(beasShift, cy.id), requestingNurseId: ann.id },
    };

    expect(() => evaluateExchange(input)).toThrow('That shift belongs to Bea Ng, not Ann Lee.');
  });

  it('says a shift from before the period is history, without quoting an id', () => {
    resetFixtureCounters();
    const ann = makeNurse({ firstName: 'Ann', lastName: 'Lee' });
    const bea = makeNurse({ firstName: 'Bea', lastName: 'Ng' });
    const lastWeek = assign(ann.id, DAY_12, '2025-12-30');
    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [ann, bea],
        assignments: [],
        priorAssignments: [{ ...lastWeek, inPeriod: false }] as never,
      }),
      proposal: giveaway(lastWeek, bea.id),
    };

    expect(() => evaluateExchange(input)).toThrow(
      'That shift is outside this schedule period; only this period’s shifts can be exchanged.',
    );
  });

  it('says a shift she was floated off cannot be traded, rather than calling it history', () => {
    resetFixtureCounters();
    const ann = makeNurse({ firstName: 'Ann', lastName: 'Lee' });
    const bea = makeNurse({ firstName: 'Bea', lastName: 'Ng' });
    const tuesday = { ...assign(ann.id, DAY_12, '2026-01-06'), floatedTo: '5 East' };
    // As the loader hands it over: busy time in the tail, on an inactive copy type.
    const busy = floatedOff([tuesday], [DAY_12]);
    const base = solveInputFrom({ startDate: START, endDate: END, nurses: [ann, bea] });
    const input: ExchangeInput = {
      ...base,
      shiftTypes: [...base.shiftTypes, ...busy.shiftTypes],
      priorAssignments: busy.assignments,
      proposal: giveaway(tuesday, bea.id),
    };

    expect(() => evaluateExchange(input)).toThrow(
      'Ann Lee was floated to 5 East for that shift; it cannot be traded.',
    );
  });

  it('says a shift that is gone is no longer on the schedule, without quoting an id', () => {
    resetFixtureCounters();
    const ann = makeNurse({ firstName: 'Ann', lastName: 'Lee' });
    const bea = makeNurse({ firstName: 'Bea', lastName: 'Ng' });
    const removed = assign(ann.id, DAY_12, '2026-01-06');
    const input: ExchangeInput = {
      ...solveInputFrom({ startDate: START, endDate: END, nurses: [ann, bea], assignments: [] }),
      proposal: giveaway(removed, bea.id),
    };

    expect(() => evaluateExchange(input)).toThrow('That shift is no longer on this schedule.');
  });

  it('refuses an exchange between a nurse and herself without quoting an id', () => {
    resetFixtureCounters();
    const ann = makeNurse({ firstName: 'Ann', lastName: 'Lee' });
    const shift = assign(ann.id, DAY_12, '2026-01-06');
    const input: ExchangeInput = {
      ...solveInputFrom({ startDate: START, endDate: END, nurses: [ann], assignments: [shift] }),
      proposal: giveaway(shift, ann.id),
    };

    expect(() => evaluateExchange(input)).toThrow('An exchange needs two different nurses.');
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

    expect(() => evaluateExchange(input)).toThrow(
      'A giveaway takes nothing back; to get a shift in return, propose a trade.',
    );
  });

  it('planExchange carries charge and notes across and swaps the nurse ids', () => {
    resetFixtureCounters();
    const alice = makeNurse({ firstName: 'Alice', lastName: 'Kwan' });
    const bo = makeNurse({ firstName: 'Bo', lastName: 'Lindqvist', isChargeEligible: true });

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

  it('does not hand the charge flag to a nurse who cannot take charge', () => {
    resetFixtureCounters();
    const alice = makeNurse({ firstName: 'Alice', lastName: 'Kwan', isChargeEligible: true });
    const bo = makeNurse({ firstName: 'Bo', lastName: 'Lindqvist' }); // not charge-eligible
    const aliceShift = assign(alice.id, DAY_12, '2026-01-06', { isCharge: true });

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [alice, bo],
        assignments: [aliceShift],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      }),
      proposal: giveaway(aliceShift, bo.id),
    };

    const plan = planExchange(input);
    expect(plan.create[0]!.isCharge).toBe(false);
    expect(plan.chargeTo).toBeUndefined();

    const result = evaluateExchange(input);
    expect(result.verdict).toBe('blocked');
    expect(result.shiftViolationsIntroduced.map((v) => v.code)).toContain('missing_charge_nurse');
  });

  it('lets a charge nurse give her shift to a nurse who cannot take charge when an eligible nurse stays on it', () => {
    resetFixtureCounters();
    // Per diem, so the giveaway does not also warn that it leaves Carla short of a contract.
    const carla = makeNurse({
      firstName: 'Carla',
      lastName: 'Diaz',
      isChargeEligible: true,
      employmentType: 'per_diem',
    });
    const wes = makeNurse({ firstName: 'Wes', lastName: 'Tran' }); // not charge-eligible
    const eli = makeNurse({ firstName: 'Eli', lastName: 'Moss', isChargeEligible: true });
    const carlaRow = assign(carla.id, DAY_12, '2026-01-06', { isCharge: true });
    const eliRow = assign(eli.id, DAY_12, '2026-01-06');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [carla, wes, eli],
        assignments: [carlaRow, eliRow],
        coverageRequirements: coverageAllWeek(DAY_12, 'RN', 1, 1),
      }),
      proposal: giveaway(carlaRow, wes.id),
    };

    const result = evaluateExchange(input);
    expect(result.verdict).toBe('ok');
    expect(result.blockers).toEqual([]);
    expect(result.notes).toEqual([
      'Eli Moss takes charge of Tue Jan 6 D12, since Wes Tran cannot take charge.',
    ]);

    const plan = planExchange(input);
    expect(plan.create[0]!.isCharge).toBe(false);
    expect(plan.chargeTo).toEqual([eliRow.id]);
  });

  it("does not carry the giver's overtime flag to a nurse on straight time", () => {
    resetFixtureCounters();
    // Per diem, so the giveaway does not also warn that it leaves Gus short of a contract.
    const gus = makeNurse({ firstName: 'Gus', lastName: 'Farah', employmentType: 'per_diem' });
    const tia = makeNurse({ firstName: 'Tia', lastName: 'Lowe' });
    const gusThursday = assign(gus.id, DAY_12, '2026-01-08', { isOvertime: true });
    const rules = defaultRuleSet('unit-1');
    const ruleSet = {
      ...rules,
      configs: rules.configs.map((c) =>
        c.ruleId === 'no-mandatory-overtime' ? { ...c, enabled: true } : c,
      ),
    };

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [gus, tia],
        assignments: [gusThursday],
        ruleSet,
      }),
      proposal: giveaway(gusThursday, tia.id),
    };

    // Hand: Tia has 0 h that week, so one 12 h shift is 28 h under the 40 h threshold.
    expect(evaluateExchange(input).verdict).toBe('ok');
    expect(planExchange(input).create[0]!.isOvertime).toBe(false);
  });

  it("prices the overtime warning at the pickup's own cost, not the whole exchange's", () => {
    resetFixtureCounters();
    const tia = makeNurse({ firstName: 'Tia', lastName: 'Lowe' });
    const gus = makeNurse({ firstName: 'Gus', lastName: 'Farah' });
    const tiaWeek = [
      assign(tia.id, DAY_12, '2026-01-04'),
      assign(tia.id, DAY_12, '2026-01-05'),
      assign(tia.id, DAY_12, '2026-01-06'),
    ];
    const gusThursday = assign(gus.id, DAY_12, '2026-01-08');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [tia, gus],
        assignments: [...tiaWeek, gusThursday],
        cost: {
          payRates: [payRate(50)],
          differentials: [],
          overtimeRules: [overtimeRule('weekly', 40, 1.5)],
        },
      }),
      proposal: giveaway(gusThursday, tia.id),
    };

    // Hand: Tia 36 + 12 = 48 h, 8 past 40. Her pickup costs 12 × $50 = $600 plus 8 × $25
    // premium = $200, so +$800. The exchange's net (+$200) nets out Gus's saved $600.
    // 48 h is not over the default 48 h cap.
    const result = evaluateExchange(input);
    expect(result.warnings).toContain('Creates 8 hours of overtime for Tia Lowe, +$800.');
  });

  it('quotes a picked-up Saturday 19:00 night against the week it opens, not the one before', () => {
    resetFixtureCounters();
    // Week from Saturday 19:00. Tia works Wed–Fri 7–9 Jan (36h, the week from Sat 3 Jan) and
    // Mon–Wed 12–14 Jan (36h, the week from Sat 10 Jan 19:00). Gus's Sat 10 Jan 19:00 night
    // starts on the boundary, so it is the second week's: 36 + 12 = 48h, 8 past 40. Quoted
    // against the first week it would read 36 + 0, no overtime.
    const tia = makeNurse({ firstName: 'Tia', lastName: 'Lowe', contractedHoursPerPeriod: 120 });
    const gus = makeNurse({ firstName: 'Gus', lastName: 'Farah' });
    const tiaDays = [
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-12',
      '2026-01-13',
      '2026-01-14',
    ].map((d) => assign(tia.id, DAY_12, d));
    const gusNight = assign(gus.id, NIGHT_12, '2026-01-10');
    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [tia, gus],
        assignments: [...tiaDays, gusNight],
        ruleParams: { 'max-hours-per-week': { workWeekStartsOn: 6, workWeekStartMinute: 1140 } },
        cost: {
          payRates: [payRate(50)],
          differentials: [],
          overtimeRules: [overtimeRule('weekly', 40, 1.5)],
        },
      }),
      proposal: giveaway(gusNight, tia.id),
    };
    const result = evaluateExchange(input);
    expect(result.warnings.find((w) => w.startsWith('Creates'))).toMatch(
      /^Creates 8 hours of overtime for Tia Lowe/,
    );
  });

  it("blocks a trade that makes a nurse's existing hours breach worse", () => {
    resetFixtureCounters();
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Ortiz' });
    // Spaced so no run of consecutive days is what blocks it.
    const anaWeek = ['2026-01-04', '2026-01-05', '2026-01-07', '2026-01-08'].map((d) =>
      assign(ana.id, DAY_12, d),
    );
    const benSaturday = assign(ben.id, DAY_12, '2026-01-10');

    const input: ExchangeInput = {
      ...solveInputFrom({
        startDate: START,
        endDate: END,
        nurses: [ana, ben],
        assignments: [...anaWeek, benSaturday],
        ruleParams: { 'max-hours-per-week': { maxHoursPerWeek: 36 } },
      }),
      proposal: giveaway(benSaturday, ana.id),
    };

    // Hand: Ana already works 48 h against a 36 h cap (12 over); a fifth 12 makes 60 h, 24 over.
    const result = evaluateExchange(input);
    expect(result.verdict).toBe('blocked');
    expect(result.blockers.some((b) => /cap/.test(b) && b.includes('Ana'))).toBe(true);
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
