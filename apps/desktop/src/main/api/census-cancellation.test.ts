/**
 * Sending a nurse home when the census drops. The order itself is core's; what is tested here is
 * what main adds: it recomputes the excess, refuses anyone but the next in the order, and in one
 * transaction records the cancellation, removes the shift (with a reason on a published period)
 * and audits it.
 */

import { addDays, isoDate, type Nurse } from '@shiftnurse/core';
import {
  auditHistoryFor,
  cancellationHistory,
  getAssignment,
  listAssignmentsForPeriodOnDate,
  listChanges,
  listShiftCancellationsForPeriod,
  publishSchedule,
  recordShiftCancellation,
  saveCancellationPolicy,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overstaffedRoles } from './census-cancellation.js';
import { ACTOR } from './context.js';
import { dayOfApi } from './dayof.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const date = () => addDays(f.seeded.draftStart, 4);
const dayOf = () => dayOfApi(f.handle.db);
const name = (n: Nurse) => `${n.firstName} ${n.lastName}`;

/** Every RN on the unit works the day shift on `date()`: far more than any floor needs. */
function everyoneComesIn() {
  for (const nurse of f.rns) {
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.day.id,
      date: date(),
    });
  }
}

const orderView = (volunteers: string[] = []) =>
  dayOf().cancellationOrder(f.seeded.draftPeriodId, date(), f.day.id, 'RN', volunteers);

describe('a shift with more nurses than its patients need', () => {
  it('reports the excess on the Today read, and not on a shift staffed to need', () => {
    expect(
      dayOf()
        .today(f.seeded.unitId, date())
        .shifts.every((s) => s.overstaffed.length === 0),
    ).toBe(true);
    everyoneComesIn();
    const shift = dayOf()
      .today(f.seeded.unitId, date())
      .shifts.find((s) => s.shiftType.id === f.day.id && s.date === date())!;
    const rn = shift.overstaffed.find((o) => o.role === 'RN')!;
    expect(rn.staffed).toBe(f.rns.length);
    expect(rn.excess).toBe(f.rns.length - rn.required);
    expect(rn.excess).toBeGreaterThan(0);
    expect(rn.periodId).toBe(f.seeded.draftPeriodId);
  });

  it('puts a volunteer first, with the order’s words for why, and shows the charge nurse as excluded', () => {
    everyoneComesIn();
    const charge = f.rns[0]!;
    const volunteer = f.rns[3]!;
    scheduleApi(f.handle.db).updateAssignment(
      listAssignmentsForPeriodOnDate(f.handle.db, f.seeded.draftPeriodId, date()).find(
        (a) => a.nurseId === charge.id,
      )!.id,
      { isCharge: true },
    );
    const view = orderView([volunteer.id]);
    expect(view.order[0]).toMatchObject({
      nurseId: volunteer.id,
      name: name(volunteer),
      tier: 'volunteer',
      reason: `${name(volunteer)} offered to go home.`,
    });
    expect(view.excluded).toEqual([
      {
        nurseId: charge.id,
        name: name(charge),
        reason: `${name(charge)} is the charge nurse on this shift.`,
      },
    ]);
    expect(view.order.map((p) => p.nurseId)).not.toContain(charge.id);
  });
});

describe('the rotation after earlier cancellations', () => {
  it('sends home last the nurse who was cancelled last week', () => {
    everyoneComesIn();
    // Per diem and agency staff go before the rotation; leave them out to see the rotation alone.
    saveCancellationPolicy(f.handle.db, f.seeded.unitId, ['rotation'], ACTOR);
    const sentHomeBefore = orderView().order[0]!;
    recordShiftCancellation(
      f.handle.db,
      {
        periodId: f.seeded.draftPeriodId,
        nurseId: sentHomeBefore.nurseId,
        shiftTypeId: f.day.id,
        date: addDays(date(), -7),
        reason: 'Rotation: earlier',
      },
      ACTOR,
    );
    const order = orderView().order;
    expect(order.at(-1)!.nurseId).toBe(sentHomeBefore.nurseId);
    expect(order.at(-1)!.reason).toMatch(/^Rotation: 1 low-census cancellation, last on /);
  });
});

describe('cancelling for census', () => {
  it('removes the shift, records the cancellation with its reason, and audits it', () => {
    everyoneComesIn();
    const volunteer = f.rns[2]!;
    const view = orderView([volunteer.id]);
    const record = dayOf().cancelForCensus(
      f.seeded.draftPeriodId,
      date(),
      f.day.id,
      'RN',
      [volunteer.id],
      volunteer.id,
    );
    expect(record).toMatchObject({
      nurseId: volunteer.id,
      date: date(),
      shiftTypeId: f.day.id,
      reason: `${name(volunteer)} offered to go home.`,
      enteredBy: 'manager',
    });
    expect(view.order[0]!.assignmentId).not.toBeUndefined();
    expect(getAssignment(f.handle.db, view.order[0]!.assignmentId)).toBeUndefined();
    expect(listShiftCancellationsForPeriod(f.handle.db, f.seeded.draftPeriodId)).toEqual([record]);
    expect(auditHistoryFor(f.handle.db, 'shift_cancellation', record.id)[0]).toMatchObject({
      action: 'create',
      actor: ACTOR,
      reason: record.reason,
    });
    expect(
      auditHistoryFor(f.handle.db, 'assignment', view.order[0]!.assignmentId)[0],
    ).toMatchObject({ action: 'delete' });
  });

  it('counts the cancellation in the nurse’s history', () => {
    everyoneComesIn();
    const before = orderView();
    const first = before.order[0]!;
    dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], first.nurseId);
    expect(cancellationHistory(f.handle.db, f.seeded.unitId, date()).get(first.nurseId)).toEqual({
      count: 1,
      lastOn: date(),
    });
  });

  it('refuses to send home anyone but the next nurse in the order', () => {
    everyoneComesIn();
    const [first, second] = orderView().order;
    expect(() =>
      dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], second!.nurseId),
    ).toThrow(new RegExp(`^${first!.name} goes home before ${second!.name}`));
    expect(listShiftCancellationsForPeriod(f.handle.db, f.seeded.draftPeriodId)).toEqual([]);
    expect(getAssignment(f.handle.db, second!.assignmentId)).toBeDefined();
  });

  it('refuses to cancel the charge nurse', () => {
    everyoneComesIn();
    const charge = f.rns[0]!;
    scheduleApi(f.handle.db).updateAssignment(
      listAssignmentsForPeriodOnDate(f.handle.db, f.seeded.draftPeriodId, date()).find(
        (a) => a.nurseId === charge.id,
      )!.id,
      { isCharge: true },
    );
    expect(() =>
      dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], charge.id),
    ).toThrow(`${name(charge)} is the charge nurse on this shift.`);
  });

  it('refuses once the shift is no longer over its requirement', () => {
    everyoneComesIn();
    let guard = f.rns.length;
    while (orderView().excess > 0 && guard-- > 0) {
      const next = orderView().order[0]!;
      dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], next.nurseId);
    }
    expect(orderView().excess).toBe(0);
    const remaining = listAssignmentsForPeriodOnDate(f.handle.db, f.seeded.draftPeriodId, date())
      .filter((a) => a.shiftTypeId === f.day.id)
      .map((a) => a.nurseId);
    expect(() =>
      dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], remaining[0]!),
    ).toThrow(/no longer over its requirement/);
  });

  it('on a published schedule writes the removal to the change log under the cancellation reason', () => {
    everyoneComesIn();
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
    const first = orderView().order[0]!;
    dayOf().cancelForCensus(f.seeded.draftPeriodId, date(), f.day.id, 'RN', [], first.nurseId);
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'removed', nurseId: first.nurseId, source: 'census' });
    expect(changes[0]!.reason).toMatch(/^Low census: .+ — /);
    expect(changes[0]!.reason).toContain(first.reason);
  });

  it('follows the unit’s own order of tiers', () => {
    everyoneComesIn();
    saveCancellationPolicy(f.handle.db, f.seeded.unitId, ['rotation'], ACTOR);
    expect(orderView(['x']).order.every((p) => p.tier === 'rotation')).toBe(true);
  });
});

describe('overstaffing under a licensed-nurse ratio', () => {
  const role = (r: 'RN' | 'LPN' | 'CNA', required: number, staffed: number) => ({
    role: r,
    required,
    staffed,
    shortfall: Math.max(0, required - staffed),
    bindingConstraint: 'ratio' as const,
  });
  const check = (rns: number, lvns: number) => ({
    date: isoDate('2026-01-06'),
    shiftTypeId: 'st-d12',
    basis: 'forecast' as const,
    census: 20,
    // Four licensed, at least two of them RNs.
    byRole: { RN: role('RN', 2, rns), LPN: role('LPN', 0, lvns), CNA: role('CNA', 0, 0) },
    licensed: { required: 4, staffed: rns + lvns, shortfall: Math.max(0, 4 - rns - lvns) },
    short: false,
    ratioBreached: false,
  });

  it('sends nobody home whom the pool still needs, though RNs are above the RN minimum', () => {
    // Three RNs and one LVN make exactly four licensed: the third RN is not spare.
    expect(overstaffedRoles('p1', check(3, 1))).toEqual([]);
  });

  it('offers the pool’s one spare once, as an LVN, keeping the RN who can fill any place', () => {
    // Five licensed against four: one nurse may go, not one RN and one LVN.
    const over = overstaffedRoles('p1', check(3, 2));
    expect(over.map((o) => [o.role, o.excess])).toEqual([['LPN', 1]]);
  });

  it('offers an RN once no LVN is spare', () => {
    // Four RNs and no LVN against four licensed with two RNs: the pool spares nobody...
    expect(overstaffedRoles('p1', check(4, 0))).toEqual([]);
    // ...and five RNs spare one RN.
    expect(overstaffedRoles('p1', check(5, 0)).map((o) => [o.role, o.excess])).toEqual([['RN', 1]]);
  });
});
