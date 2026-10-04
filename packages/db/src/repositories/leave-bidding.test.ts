/**
 * A summer bidding round, as a manager runs it: bids go in, the award runs once in seniority
 * order, the leave lands as approved time off that clears the draft grid, and every denial is on
 * the record in the sentence the manager will read to the nurse.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import {
  awardRound,
  closeLeaveBidRound,
  createLeaveBidRound,
  getLeaveBidRound,
  type LeaveBidRoundInput,
  listLeaveBidRounds,
  listLeaveBids,
  submitLeaveBid,
  updateLeaveBidRound,
} from './leave-bidding.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, listAssignmentsForPeriod } from './schedule.js';
import { listTimeOffForUnit } from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let senior: Nurse;
let junior: Nurse;
let mid: Nurse;

const week = (start: string, end: string, rank = 1) => ({
  rank,
  startDate: isoDate(start),
  endDate: isoDate(end),
});

function roundInput(overrides: Partial<LeaveBidRoundInput> = {}): LeaveBidRoundInput {
  return {
    unitId,
    name: 'Summer 2026',
    coversStart: isoDate('2026-07-01'),
    coversEnd: isoDate('2026-08-31'),
    opensOn: isoDate('2026-03-01'),
    closesOn: isoDate('2026-03-31'),
    offPerDay: { RN: 1 },
    ...overrides,
  };
}

function nurse(n: string, seniority: string): Nurse {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: n,
      firstName: n,
      lastName: 'Nurse',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate(seniority),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  );
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  senior = nurse('Sen', '2010-03-01');
  mid = nurse('Mid', '2015-03-01');
  junior = nurse('Jun', '2020-03-01');
});

afterEach(() => handle.close());

describe('setting up a bidding round', () => {
  it('lists the round with its places and an open status, and audits the create', () => {
    const round = createLeaveBidRound(handle.db, roundInput({ maxAwardsPerNurse: 2 }), ACTOR);
    expect(listLeaveBidRounds(handle.db, unitId)).toEqual([round]);
    expect(round).toMatchObject({ status: 'open', offPerDay: { RN: 1 }, maxAwardsPerNurse: 2 });
    expect(auditHistoryFor(handle.db, 'leave_bid_round', round.id)[0]).toMatchObject({
      action: 'create',
      actor: ACTOR,
    });
  });

  it('refuses a season that ends before it starts', () => {
    expect(() =>
      createLeaveBidRound(
        handle.db,
        roundInput({ coversStart: isoDate('2026-08-31'), coversEnd: isoDate('2026-07-01') }),
        ACTOR,
      ),
    ).toThrow(/ends before it starts/);
    expect(listLeaveBidRounds(handle.db, unitId)).toEqual([]);
  });

  it('refuses a round that gives no role a place off, on create and on edit', () => {
    expect(() => createLeaveBidRound(handle.db, roundInput({ offPerDay: {} }), ACTOR)).toThrow(
      /at least one place off a day for some role/,
    );
    expect(() =>
      createLeaveBidRound(handle.db, roundInput({ offPerDay: { RN: 0 } }), ACTOR),
    ).toThrow(/at least one place off a day for some role/);
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    expect(() => updateLeaveBidRound(handle.db, round.id, { offPerDay: { RN: 0 } }, ACTOR)).toThrow(
      /at least one place off a day for some role/,
    );
    expect(getLeaveBidRound(handle.db, round.id)!.offPerDay).toEqual({ RN: 1 });
  });

  it('refuses places that are negative or part of a person', () => {
    expect(() =>
      createLeaveBidRound(handle.db, roundInput({ offPerDay: { RN: -1 } }), ACTOR),
    ).toThrow(/whole number, zero or more/);
    expect(() =>
      createLeaveBidRound(handle.db, roundInput({ offPerDay: { RN: 1.5 } }), ACTOR),
    ).toThrow(/whole number, zero or more/);
  });

  it('keeps the old round in the audit row when the places change, and clears a limit with null', () => {
    const round = createLeaveBidRound(handle.db, roundInput({ maxAwardsPerNurse: 2 }), ACTOR);
    const updated = updateLeaveBidRound(
      handle.db,
      round.id,
      { offPerDay: { RN: 2 }, maxAwardsPerNurse: null },
      ACTOR,
    );
    expect(updated.offPerDay).toEqual({ RN: 2 });
    expect(updated.maxAwardsPerNurse).toBeUndefined();
    const entry = auditHistoryFor(handle.db, 'leave_bid_round', round.id)[0]!;
    expect(entry).toMatchObject({ action: 'update', before: { offPerDay: { RN: 1 } } });
  });

  it('refuses an edit that tries to move the round to another unit', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    expect(() =>
      updateLeaveBidRound(handle.db, round.id, { unitId: 'other' } as never, ACTOR),
    ).toThrow(/cannot change 'unitId'/);
  });
});

describe('entering bids', () => {
  it('replaces a nurse’s bid instead of adding a second one', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    const first = submitLeaveBid(
      handle.db,
      round.id,
      senior.id,
      [week('2026-07-06', '2026-07-10')],
      ACTOR,
    );
    const second = submitLeaveBid(
      handle.db,
      round.id,
      senior.id,
      [week('2026-07-13', '2026-07-17')],
      ACTOR,
    );
    expect(second.id).toBe(first.id);
    const bids = listLeaveBids(handle.db, round.id);
    expect(bids).toHaveLength(1);
    expect(bids[0]!.choices).toEqual([week('2026-07-13', '2026-07-17')]);
    expect(auditHistoryFor(handle.db, 'leave_bid', first.id).map((e) => e.action)).toEqual([
      'update',
      'create',
    ]);
  });

  it('records that the manager entered the bid, and reads it back that way', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    const bid = submitLeaveBid(
      handle.db,
      round.id,
      senior.id,
      [week('2026-07-06', '2026-07-10')],
      ACTOR,
    );
    expect(bid.enteredBy).toBe('manager');
    expect(listLeaveBids(handle.db, round.id)[0]!.enteredBy).toBe('manager');
  });

  it('stores choices in rank order and refuses a gap in the ranking', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    const bid = submitLeaveBid(
      handle.db,
      round.id,
      senior.id,
      [week('2026-07-13', '2026-07-17', 2), week('2026-07-06', '2026-07-10', 1)],
      ACTOR,
    );
    expect(bid.choices.map((c) => c.rank)).toEqual([1, 2]);
    expect(() =>
      submitLeaveBid(handle.db, round.id, mid.id, [week('2026-07-06', '2026-07-10', 2)], ACTOR),
    ).toThrow(/ranked 1, 2, 3/);
  });

  it('says so when a choice falls outside the season', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    expect(() =>
      submitLeaveBid(handle.db, round.id, senior.id, [week('2026-06-29', '2026-07-03')], ACTOR),
    ).toThrow(/Choice 1 is outside Summer 2026, which covers 2026-07-01 to 2026-08-31/);
    expect(listLeaveBids(handle.db, round.id)).toEqual([]);
  });

  it('takes no more bids once the round is closed', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    closeLeaveBidRound(handle.db, round.id, ACTOR);
    expect(() =>
      submitLeaveBid(handle.db, round.id, senior.id, [week('2026-07-06', '2026-07-10')], ACTOR),
    ).toThrow(/closed; it no longer takes bids/);
  });

  it('refuses a nurse from another unit', () => {
    const other = createUnit(
      handle.db,
      { name: 'ICU', unitType: 'ICU', payPeriodDays: 14, payPeriodAnchor: isoDate('2026-01-04') },
      ACTOR,
    ).id;
    const stranger = createNurse(
      handle.db,
      { ...senior, unitId: other, employeeId: 'X1' } as Omit<Nurse, 'id'>,
      ACTOR,
    );
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    expect(() =>
      submitLeaveBid(handle.db, round.id, stranger.id, [week('2026-07-06', '2026-07-10')], ACTOR),
    ).toThrow(/not on this unit/);
  });
});

describe('awarding a round', () => {
  function threeNurseRound() {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    // Both want the week of July 6, and the unit can spare one RN a day.
    submitLeaveBid(handle.db, round.id, junior.id, [week('2026-07-06', '2026-07-10')], ACTOR);
    submitLeaveBid(handle.db, round.id, senior.id, [week('2026-07-06', '2026-07-10')], ACTOR);
    submitLeaveBid(handle.db, round.id, mid.id, [week('2026-07-20', '2026-07-24')], ACTOR);
    return round;
  }

  it('gives the senior nurse the week and denies the junior one with the reason on the record', () => {
    const round = threeNurseRound();

    const {
      result,
      awarded,
      round: after,
    } = transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR));

    expect(result.order).toEqual([senior.id, mid.id, junior.id]);
    expect(awarded.map((a) => a.award.nurseId).sort()).toEqual([senior.id, mid.id].sort());
    expect(after.status).toBe('awarded');
    expect(getLeaveBidRound(handle.db, round.id)!.awardedAt).toBeTypeOf('number');

    // Each award is approved PTO, with no pending request left behind.
    const leave = listTimeOffForUnit(handle.db, unitId);
    expect(leave).toHaveLength(2);
    expect(leave.every((r) => r.status === 'approved' && r.type === 'pto')).toBe(true);

    const juniorBid = listLeaveBids(handle.db, round.id).find((b) => b.nurseId === junior.id)!;
    const denial = auditHistoryFor(handle.db, 'leave_bid', juniorBid.id).find(
      (e) => e.action === 'deny',
    )!;
    expect(denial.actor).toBe(ACTOR);
    expect(denial.reason).toBe(result.denials[0]!.reason);
    expect(denial.reason).toContain('taken by Sen Nurse');
    expect(denial.reason).toContain('senior to Jun Nurse');
  });

  it('pays a week won as the three 12s a full-timer would have worked', () => {
    createShiftType(
      handle.db,
      {
        unitId,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#0ea5e9',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    const round = threeNurseRound();
    transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR));
    // 72 hours a 14-day pay period is three 12s a week: Mon 6 – Fri 10 July pays 36 hours.
    const won = listTimeOffForUnit(handle.db, unitId).find((r) => r.nurseId === senior.id)!;
    expect(won.paidHours).toBe(36);
  });

  it('refuses to award the same round twice and approves nothing more', () => {
    const round = threeNurseRound();
    transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR));
    expect(() => transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR))).toThrow(
      /already been awarded/,
    );
    expect(listTimeOffForUnit(handle.db, unitId)).toHaveLength(2);
  });

  it('refuses to award a round nobody bid in', () => {
    const round = createLeaveBidRound(handle.db, roundInput(), ACTOR);
    expect(() => transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR))).toThrow(
      /Nobody has bid in Summer 2026 yet/,
    );
    expect(getLeaveBidRound(handle.db, round.id)!.status).toBe('open');
  });

  it('takes the awarded nurse off the draft shift on the awarded day, and no other', () => {
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
          configs: [],
        },
        ACTOR,
      ),
    );
    const shiftTypeId = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#0ea5e9',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
    const periodId = createPeriod(
      handle.db,
      {
        unitId,
        name: 'July',
        startDate: isoDate('2026-07-05'),
        endDate: isoDate('2026-07-18'),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    ).id;
    const shift = (date: string) =>
      createAssignment(
        handle.db,
        { periodId, nurseId: senior.id, shiftTypeId, date: isoDate(date), source: 'manual' },
        ACTOR,
      );
    shift('2026-07-08');
    shift('2026-07-13');

    const round = threeNurseRound();
    const { awarded } = transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR));

    expect(awarded.find((a) => a.award.nurseId === senior.id)!.lifted.map((a) => a.date)).toEqual([
      '2026-07-08',
    ]);
    expect(listAssignmentsForPeriod(handle.db, periodId).map((a) => a.date)).toEqual([
      '2026-07-13',
    ]);
  });

  it('counts leave approved by an earlier round against the places', () => {
    const round = threeNurseRound();
    // The first round's award is leave approved by the time a second round runs.
    transact(handle.db, (tx) => awardRound(tx, round.id, ACTOR));
    const next = createLeaveBidRound(
      handle.db,
      roundInput({ name: 'Summer 2026 second round' }),
      ACTOR,
    );
    submitLeaveBid(handle.db, next.id, junior.id, [week('2026-07-06', '2026-07-10')], ACTOR);
    const { result } = transact(handle.db, (tx) => awardRound(tx, next.id, ACTOR));
    expect(result.awards).toEqual([]);
    expect(result.denials[0]!.reason).toContain('Sen Nurse (leave already approved)');
  });
});
