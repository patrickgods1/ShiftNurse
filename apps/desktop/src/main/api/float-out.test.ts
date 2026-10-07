/**
 * Floating a nurse to another unit. The order itself is core's; what is tested here is what main
 * adds: it refuses anyone but the first in the order, and in one transaction records the float,
 * removes the home shift (with the reason on a published period) and audits it.
 */

import { addDays, isoDate, type Nurse } from '@shiftnurse/core';
import {
  auditHistoryFor,
  createAssignment,
  createNurse,
  createUnit,
  getAssignment,
  listAssignmentsForPeriodOnDate,
  listChanges,
  publishSchedule,
  updateNurse,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { floatOutApi } from './float-out.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

const date = () => addDays(f.seeded.draftStart, 4);
const api = () => floatOutApi(f.handle.db);
const name = (n: Nurse) => `${n.firstName} ${n.lastName}`;
const request = (volunteers: string[] = []) => ({
  periodId: f.seeded.draftPeriodId,
  date: date(),
  shiftTypeId: f.day.id,
  role: 'RN' as const,
  volunteers,
});
const send = (nurseId: string, volunteers: string[] = [], extra = {}) =>
  api().send({
    ...request(volunteers),
    nurseId,
    toUnit: '4B Telemetry',
    reason: 'Floated to 4B Telemetry',
    ...extra,
  });

/**
 * Every RN works the day shift. Nurse ids are random, so which RNs the seed made float-eligible
 * varies run to run; make all of them eligible so the order never depends on that.
 */
function everyoneComesIn() {
  for (const nurse of f.rns) updateNurse(f.handle.db, nurse.id, { isFloatEligible: true }, ACTOR);
  for (const nurse of f.rns) {
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.day.id,
      date: date(),
    });
  }
}

describe('floating a nurse off a shift', () => {
  it('ranks a volunteer first and names the nurses nobody may float', () => {
    everyoneComesIn();
    const charge = f.rns[0]!;
    scheduleApi(f.handle.db).updateAssignment(
      listAssignmentsForPeriodOnDate(f.handle.db, f.seeded.draftPeriodId, date()).find(
        (a) => a.nurseId === charge.id,
      )!.id,
      { isCharge: true },
    );
    const volunteer = f.rns[3]!;
    const view = api().order(request([volunteer.id]));
    expect(view.order[0]).toMatchObject({
      nurseId: volunteer.id,
      name: name(volunteer),
      rank: 1,
      basis: 'volunteer',
      reason: 'Volunteered',
    });
    expect(view.excluded).toContainEqual({
      nurseId: charge.id,
      name: name(charge),
      reason: 'Charge nurse for the shift',
    });
  });

  it('records the float and takes the shift off the home schedule, with an audit row', () => {
    everyoneComesIn();
    const volunteer = f.rns[2]!;
    const place = api().order(request([volunteer.id])).order[0]!;
    const record = send(volunteer.id, [volunteer.id], { objection: 'Not competent on tele' });
    expect(record).toMatchObject({
      unitId: f.seeded.unitId,
      nurseId: volunteer.id,
      date: date(),
      shiftTypeId: f.day.id,
      toUnit: '4B Telemetry',
      volunteered: true,
      objection: 'Not competent on tele',
    });
    expect(getAssignment(f.handle.db, place.assignmentId)).toBeUndefined();
    expect(api().history(f.seeded.unitId, addDays(date(), -365))).toEqual([record]);
    expect(auditHistoryFor(f.handle.db, 'float_record', record.id)[0]).toMatchObject({
      action: 'create',
      actor: ACTOR,
    });
  });

  it('counts a mandated float against the nurse’s turn in the next order', () => {
    everyoneComesIn();
    const first = api().order(request()).order[0]!;
    const record = send(first.nurseId);
    expect(record.volunteered).toBe(false);
    // Put the same nurse back on the shift: the one just floated now sorts after the rest.
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: first.nurseId,
      shiftTypeId: f.day.id,
      date: date(),
    });
    const after = api().order(request()).order;
    expect(after.at(-1)!.nurseId).toBe(first.nurseId);
    // One mandated float in the last year, where everyone else has none.
    expect(after.at(-1)!.reason).toMatch(
      /^Rotation: floated 1 time in the last year, last on [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}$/,
    );
    expect(after[0]!.reason).toMatch(/^Rotation: not floated in the last year/);
  });

  it('refuses to rank a shift holding a nurse missing from the roster', () => {
    everyoneComesIn();
    const other = createUnit(
      f.handle.db,
      {
        name: 'Elsewhere',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const stranger = createNurse(
      f.handle.db,
      { ...f.rns[0]!, id: undefined, unitId: other.id, employeeId: 'X-9001' } as never,
      ACTOR,
    );
    createAssignment(
      f.handle.db,
      {
        periodId: f.seeded.draftPeriodId,
        nurseId: stranger.id,
        shiftTypeId: f.day.id,
        date: date(),
        source: 'manual',
        isLocked: false,
        isCharge: false,
        isOvertime: false,
      },
      ACTOR,
    );
    expect(() => api().order(request())).toThrow(/not on this period's roster/);
  });

  it('refuses to float anyone but the next nurse in the order', () => {
    everyoneComesIn();
    const [first, second] = api().order(request()).order;
    expect(() => send(second!.nurseId)).toThrow(
      new RegExp(`^${first!.name} floats before ${second!.name}`),
    );
    expect(api().history(f.seeded.unitId, addDays(date(), -365))).toEqual([]);
    expect(getAssignment(f.handle.db, second!.assignmentId)).toBeDefined();
  });

  it('refuses a nurse who is not float-eligible', () => {
    everyoneComesIn();
    const fixed = f.rns[1]!;
    updateNurse(f.handle.db, fixed.id, { isFloatEligible: false }, ACTOR);
    expect(() => send(fixed.id)).toThrow(/Not float-eligible/);
  });

  it('on a published schedule writes the removal to the change log under the float reason', () => {
    everyoneComesIn();
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
    const first = api().order(request()).order[0]!;
    send(first.nurseId);
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'removed',
      nurseId: first.nurseId,
      source: 'float',
      reason: 'Floated to 4B Telemetry',
    });
  });

  it('records an objection afterwards, and refuses a blank one', () => {
    everyoneComesIn();
    const record = send(api().order(request()).order[0]!.nurseId);
    expect(() => api().recordObjection(record.id, ' ')).toThrow(/objection/);
    expect(api().recordObjection(record.id, 'Not competent on tele').objection).toBe(
      'Not competent on tele',
    );
    expect(auditHistoryFor(f.handle.db, 'float_record', record.id)[0]).toMatchObject({
      action: 'update',
    });
  });
});
