/**
 * Seniority leave bidding, worked by hand. Three RNs by seniority: Ana (2008), Bo (2012), Cy
 * (2019); one RN may be off each day unless a test says otherwise. Summer 2027.
 */

import { describe, expect, it } from 'vitest';
import type { Nurse, TimeOffRequest } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, timeOff } from '../testing/fixtures.js';
import { awardBids, type LeaveBid, type LeaveBidRound } from './bidding.js';

const ana = makeNurse({
  id: 'ana',
  firstName: 'Ana',
  lastName: 'Cruz',
  employeeId: 'E1',
  seniorityDate: isoDate('2008-03-01'),
});
const bo = makeNurse({
  id: 'bo',
  firstName: 'Bo',
  lastName: 'Li',
  employeeId: 'E2',
  seniorityDate: isoDate('2012-06-01'),
});
const cy = makeNurse({
  id: 'cy',
  firstName: 'Cy',
  lastName: 'Ng',
  employeeId: 'E3',
  seniorityDate: isoDate('2019-09-01'),
});
const NURSES: Nurse[] = [cy, bo, ana]; // deliberately not in seniority order

const ROUND: LeaveBidRound = {
  id: 'summer',
  unitId: 'unit-1',
  name: 'Summer 2027',
  coversStart: isoDate('2027-06-01'),
  coversEnd: isoDate('2027-08-31'),
  offPerDay: { RN: 1 },
};

function bid(nurse: Nurse, ...ranges: [string, string][]): LeaveBid {
  return {
    id: `bid-${nurse.id}`,
    roundId: ROUND.id,
    nurseId: nurse.id,
    choices: ranges.map(([startDate, endDate], i) => ({
      rank: i + 1,
      startDate: isoDate(startDate),
      endDate: isoDate(endDate),
    })),
  };
}

function award(
  bids: LeaveBid[],
  extra: { round?: Partial<LeaveBidRound>; approved?: TimeOffRequest[] } = {},
) {
  return awardBids({ ...ROUND, ...extra.round }, bids, NURSES, extra.approved ?? []);
}

describe('awarding leave by seniority', () => {
  it('gives the senior nurse the week two nurses both put first', () => {
    const result = award([
      bid(bo, ['2027-07-05', '2027-07-09']),
      bid(ana, ['2027-07-05', '2027-07-09']),
    ]);
    expect(result.awards).toEqual([
      expect.objectContaining({
        nurseId: 'ana',
        rank: 1,
        startDate: '2027-07-05',
        endDate: '2027-07-09',
      }),
    ]);
    expect(result.denials).toEqual([
      expect.objectContaining({
        nurseId: 'bo',
        rank: 1,
        fullDates: ['2027-07-05', '2027-07-06', '2027-07-07', '2027-07-08', '2027-07-09'],
        heldBy: ['ana'],
      }),
    ]);
    expect(result.denials[0]!.reason).toBe(
      'Choice 1 (Mon Jul 5 – Fri Jul 9): Mon Jul 5 to Fri Jul 9 already have the 1 RN off a day the round allows, taken by Ana Cruz, senior to Bo Li.',
    );
  });

  it('moves a junior nurse down to their next choice in the same pass', () => {
    const result = award([
      bid(ana, ['2027-07-05', '2027-07-09']),
      bid(bo, ['2027-07-07', '2027-07-08'], ['2027-07-19', '2027-07-23']),
    ]);
    expect(result.awards.map((a) => `${a.nurseId}:${a.rank}`)).toEqual(['ana:1', 'bo:2']);
    expect(result.denials.map((d) => `${d.nurseId}:${d.rank}`)).toEqual(['bo:1']);
  });

  it('gives everyone one week before anyone gets a second', () => {
    // Ana wants two weeks; Cy's only choice is Ana's second. Pass 1: Ana week 1, Bo, Cy week 2.
    // Pass 2: Ana's week 2 is Cy's now, though Ana is senior — one award a nurse a pass.
    const result = award([
      bid(ana, ['2027-07-05', '2027-07-09'], ['2027-08-02', '2027-08-06']),
      bid(bo, ['2027-06-14', '2027-06-18']),
      bid(cy, ['2027-08-02', '2027-08-06']),
    ]);
    expect(result.awards.map((a) => `${a.pass}:${a.nurseId}:${a.rank}`)).toEqual([
      '1:ana:1',
      '1:bo:1',
      '1:cy:1',
    ]);
    expect(result.denials).toEqual([
      expect.objectContaining({ nurseId: 'ana', rank: 2, heldBy: ['cy'], pass: 2 }),
    ]);
  });

  it('lets two off a day when the round allows two', () => {
    const result = award(
      [
        bid(ana, ['2027-07-05', '2027-07-09']),
        bid(bo, ['2027-07-05', '2027-07-09']),
        bid(cy, ['2027-07-09', '2027-07-09']),
      ],
      { round: { offPerDay: { RN: 2 } } },
    );
    expect(result.awards.map((a) => a.nurseId)).toEqual(['ana', 'bo']);
    expect(result.denials.map((d) => d.fullDates)).toEqual([['2027-07-09']]);
  });

  it('counts leave already approved against the days', () => {
    const result = award([bid(ana, ['2027-07-05', '2027-07-09'])], {
      approved: [timeOff('bo', '2027-07-08', '2027-07-08')],
    });
    expect(result.awards).toEqual([]);
    expect(result.denials[0]).toMatchObject({ fullDates: ['2027-07-08'], heldBy: ['bo'] });
  });

  it('stops at the most weeks a nurse may win in the round', () => {
    const result = award(
      [
        bid(
          ana,
          ['2027-06-07', '2027-06-11'],
          ['2027-07-05', '2027-07-09'],
          ['2027-08-02', '2027-08-06'],
        ),
      ],
      { round: { maxAwardsPerNurse: 2 } },
    );
    expect(result.awards.map((a) => a.rank)).toEqual([1, 2]);
    expect(result.denials).toEqual([
      expect.objectContaining({
        rank: 3,
        reason: expect.stringContaining('has already won the 2 choices the round allows'),
      }),
    ]);
  });

  it('labels a holder by how they hold that day, though they also won another week', () => {
    // Bo's leave on 8 Jul was approved before the round; Bo also bids for, and wins, 2–6 Aug.
    const result = award(
      [bid(bo, ['2027-08-02', '2027-08-06']), bid(cy, ['2027-07-05', '2027-07-09'])],
      {
        approved: [timeOff('bo', '2027-07-08', '2027-07-08')],
      },
    );
    expect(result.awards.map((a) => a.nurseId)).toEqual(['bo']);
    expect(result.denials[0]!.reason).toBe(
      'Choice 1 (Mon Jul 5 – Fri Jul 9): Thu Jul 8 already has the 1 RN off a day the round allows, taken by Bo Li (leave already approved).',
    );
  });

  it('says senior to, for a senior nurse who won the day, whatever leave they hold elsewhere', () => {
    const result = award(
      [bid(ana, ['2027-07-05', '2027-07-09']), bid(cy, ['2027-07-05', '2027-07-09'])],
      {
        approved: [timeOff('ana', '2027-08-16', '2027-08-16')],
      },
    );
    expect(result.denials[0]!.reason).toContain('taken by Ana Cruz, senior to Cy Ng.');
  });

  it('refuses a role the round gives no places to, in words', () => {
    const lpn = makeNurse({
      id: 'lpn',
      firstName: 'Gil',
      lastName: 'Sato',
      role: 'LPN',
      employeeId: 'L1',
      seniorityDate: isoDate('2010-01-01'),
    });
    const result = awardBids(ROUND, [bid(lpn, ['2027-07-05', '2027-07-09'])], [lpn], []);
    expect(result.denials[0]!.reason).toBe(
      'Choice 1 (Mon Jul 5 – Fri Jul 9): Summer 2027 has no places for LPNs.',
    );
  });

  it('says a choice that ends before it starts is the wrong way round', () => {
    const result = award([bid(ana, ['2027-07-09', '2027-07-05'])]);
    expect(result.denials[0]!.reason).toBe(
      'Choice 1 (Fri Jul 9 – Mon Jul 5): it ends before it starts.',
    );
  });

  it('names approved-leave holders in the same order whatever order the leave arrives in', () => {
    const leave = [
      timeOff('cy', '2027-07-08', '2027-07-08'),
      timeOff('bo', '2027-07-08', '2027-07-08'),
    ];
    const twoOff = { round: { offPerDay: { RN: 2 } } };
    const forwards = award([bid(ana, ['2027-07-05', '2027-07-09'])], {
      ...twoOff,
      approved: leave,
    });
    const backwards = award([bid(ana, ['2027-07-05', '2027-07-09'])], {
      ...twoOff,
      approved: [...leave].reverse(),
    });
    expect(backwards.denials[0]!.reason).toBe(forwards.denials[0]!.reason);
  });

  it('says a choice overlaps a week the nurse already won, not that they took it from themselves', () => {
    const result = award([bid(ana, ['2027-07-05', '2027-07-09'], ['2027-07-08', '2027-07-12'])], {
      round: { maxAwardsPerNurse: 3 },
    });
    expect(result.denials[0]!.reason).toBe(
      'Choice 2 (Thu Jul 8 – Mon Jul 12): it overlaps a week Ana Cruz has already won.',
    );
  });

  it('refuses a round that ends before it starts', () => {
    expect(() =>
      award([], {
        round: { coversStart: isoDate('2027-08-31'), coversEnd: isoDate('2027-06-01') },
      }),
    ).toThrow('Summer 2027 ends before it starts');
  });

  it('refuses a choice outside the round, saying so', () => {
    const result = award([bid(ana, ['2027-09-06', '2027-09-10'])]);
    expect(result.awards).toEqual([]);
    expect(result.denials[0]!.reason).toContain('outside Summer 2027');
  });

  it('breaks a tie on seniority date by employee number', () => {
    const twin = makeNurse({
      id: 'twin',
      firstName: 'Di',
      lastName: 'Ota',
      employeeId: 'E0',
      seniorityDate: ana.seniorityDate,
    });
    const result = awardBids(
      ROUND,
      [bid(ana, ['2027-07-05', '2027-07-09']), bid(twin, ['2027-07-05', '2027-07-09'])],
      [ana, twin],
      [],
    );
    expect(result.awards.map((a) => a.nurseId)).toEqual(['twin']);
    expect(result.order).toEqual(['twin', 'ana']);
  });

  it('gives the same awards whatever order the bids arrive in', () => {
    const bids = [
      bid(ana, ['2027-07-05', '2027-07-09'], ['2027-08-02', '2027-08-06']),
      bid(bo, ['2027-07-05', '2027-07-09'], ['2027-06-14', '2027-06-18']),
      bid(cy, ['2027-08-02', '2027-08-06'], ['2027-06-14', '2027-06-18']),
    ];
    expect(award([...bids].reverse())).toEqual(award(bids));
  });
});
