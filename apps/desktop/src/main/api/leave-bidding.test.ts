/**
 * Leave bidding through the IPC handlers: a round is run end to end the way the Requests page
 * drives it, a refusal reaches the caller in words, and the award comes back with names and the
 * denial's sentence, ready to put on screen.
 */

import { isoDate, seniorityOrder } from '@shiftnurse/core';
import { auditHistoryFor, listTimeOffForUnit } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leaveBiddingApi } from './leave-bidding.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => leaveBiddingApi(f.handle.db);

const round = () => ({
  unitId: f.seeded.unitId,
  name: 'Summer 2027',
  coversStart: isoDate('2027-07-01'),
  coversEnd: isoDate('2027-08-31'),
  opensOn: isoDate('2027-03-01'),
  closesOn: isoDate('2027-03-31'),
  offPerDay: { RN: 1 },
});

const week = { rank: 1, startDate: isoDate('2027-07-05'), endDate: isoDate('2027-07-09') };

describe('running a bidding round from the Requests page', () => {
  it('awards the senior nurse the week and returns the junior nurse’s denial in words', () => {
    const [senior, junior] = seniorityOrder(f.rns);
    const created = api().createRound(round());
    expect(api().rounds(f.seeded.unitId)).toEqual([created]);

    api().submitBid(created.id, junior!.id, [week]);
    api().submitBid(created.id, senior!.id, [week]);
    expect(
      api()
        .bids(created.id)
        .map((b) => b.nurseId)
        .sort(),
    ).toEqual([junior!.id, senior!.id].sort());

    const result = api().award(created.id);

    expect(result.round.status).toBe('awarded');
    expect(result.order.slice(0, 2).map((o) => o.nurseId)).toEqual([senior!.id, junior!.id]);
    expect(result.awards).toHaveLength(1);
    expect(result.awards[0]).toMatchObject({
      nurseId: senior!.id,
      nurseName: `${senior!.firstName} ${senior!.lastName}`,
      startDate: '2027-07-05',
      endDate: '2027-07-09',
      pass: 1,
    });
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0]!.nurseName).toBe(`${junior!.firstName} ${junior!.lastName}`);
    expect(result.denials[0]!.reason).toContain(
      `taken by ${senior!.firstName} ${senior!.lastName}`,
    );

    const approved = listTimeOffForUnit(f.handle.db, f.seeded.unitId, 'approved').filter(
      (r) => r.id === result.awards[0]!.requestId,
    );
    expect(approved).toHaveLength(1);
    const denialAudit = auditHistoryFor(f.handle.db, 'leave_bid', result.denials[0]!.bidId).find(
      (e) => e.action === 'deny',
    );
    expect(denialAudit?.reason).toBe(result.denials[0]!.reason);
  });

  it('refuses a second award in words and a bid outside the season', () => {
    const created = api().createRound(round());
    expect(() =>
      api().submitBid(created.id, f.rns[0]!.id, [
        { rank: 1, startDate: isoDate('2027-06-28'), endDate: isoDate('2027-07-02') },
      ]),
    ).toThrow(/outside Summer 2027/);
    api().submitBid(created.id, f.rns[0]!.id, [week]);
    api().award(created.id);
    expect(() => api().award(created.id)).toThrow(/already been awarded/);
  });

  it('closes a round so it takes no more bids', () => {
    const created = api().createRound(round());
    expect(api().closeRound(created.id).status).toBe('closed');
    expect(() => api().submitBid(created.id, f.rns[0]!.id, [week])).toThrow(/no longer takes bids/);
  });
});
