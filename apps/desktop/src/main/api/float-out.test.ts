/**
 * Floating a nurse to another unit. The order itself is core's; what is tested here is what main
 * adds: it refuses anyone but the first in the order, and in one transaction records the float,
 * keeps the home shift marked and locked (with the reason on a published period) and audits it.
 */

import { addDays, isoDate, type Nurse } from '@shiftnurse/core';
import {
  auditHistoryFor,
  createAssignment,
  createNurse,
  createUnit,
  getAssignment,
  listAssignmentsForPeriod,
  listAssignmentsForPeriodOnDate,
  listChanges,
  listFloatRecords,
  publishSchedule,
  transact,
  updateNurse,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { costReport } from './cost.js';
import { floatOrderFor, floatOutApi } from './float-out.js';
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
const request = (volunteers: string[] = [], on = date()) => ({
  periodId: f.seeded.draftPeriodId,
  date: on,
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
function everyoneComesIn(on = date()) {
  for (const nurse of f.rns) updateNurse(f.handle.db, nurse.id, { isFloatEligible: true }, ACTOR);
  for (const nurse of f.rns) {
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: nurse.id,
      shiftTypeId: f.day.id,
      date: on,
    });
  }
}

describe('a nurse the shift cannot spare', () => {
  it('keeps the only experienced RN off the float list', () => {
    everyoneComesIn();
    const [experienced, ...rest] = f.rns;
    // Ids are random, so the seed may have made her a new grad too.
    updateNurse(f.handle.db, experienced!.id, { isNovice: false }, ACTOR);
    for (const nurse of rest) updateNurse(f.handle.db, nurse.id, { isNovice: true }, ACTOR);

    const view = api().order(request([experienced!.id]));
    expect(view.excluded.find((e) => e.nurseId === experienced!.id)?.reason).toMatch(
      /^Needed on this shift — floating them would break /,
    );
    expect(view.order.map((p) => p.nurseId)).not.toContain(experienced!.id);
    expect(() => send(experienced!.id, [experienced!.id])).toThrow('Needed on this shift');
  });
});

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

  it('records the float and keeps the shift on the home schedule, marked, with an audit row', () => {
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
    expect(getAssignment(f.handle.db, place.assignmentId)).toMatchObject({
      nurseId: volunteer.id,
      floatedTo: '4B Telemetry',
      isLocked: true,
    });
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
    // The next day's day shift: the one just floated now sorts after the rest.
    const next = addDays(date(), 1);
    everyoneComesIn(next);
    const after = api().order(request([], next)).order;
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

  it('on a published schedule writes the float to the change log under the float reason', () => {
    everyoneComesIn();
    transact(f.handle.db, (tx) =>
      publishSchedule(tx, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR),
    );
    const first = api().order(request()).order[0]!;
    send(first.nurseId);
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'changed',
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

  it('keeps the floated nurse’s shift and her hours', () => {
    everyoneComesIn();
    const ana = f.rns[2]!;
    send(ana.id, [ana.id]);
    const kept = listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).filter(
      (a) => a.nurseId === ana.id && a.date === date(),
    );
    expect(kept).toEqual([
      expect.objectContaining({
        shiftTypeId: f.day.id,
        floatedTo: '4B Telemetry',
        isLocked: true,
      }),
    ]);
    expect(listFloatRecords(f.handle.db, f.seeded.unitId, addDays(date(), -365))).toHaveLength(1);
  });

  it('still flags the turnaround into a shift she was floated off', () => {
    everyoneComesIn();
    const ana = f.rns[2]!;
    // Her night the evening before runs 19:00 to 07:00, and the day shift starts at 07:00:
    // 0 hours of rest, whichever unit's floor she spent the day on.
    const night = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ana.id,
      shiftTypeId: f.night.id,
      date: addDays(date(), -1),
    });
    send(ana.id, [ana.id]);
    const { hardViolations } = scheduleApi(f.handle.db).validate(f.seeded.draftPeriodId).result;
    const rest = hardViolations.filter(
      (v) => v.code === 'insufficient_rest' && v.assignmentIds.includes(night.id),
    );
    expect(rest).toHaveLength(1);
    expect(rest[0]!.nurseIds).toEqual([ana.id]);
  });

  it('prices the floated shift as before: floating does not change what the period costs', () => {
    everyoneComesIn();
    const ana = f.rns[2]!;
    const before = costReport(f.handle.db, f.seeded.draftPeriodId).cost.totals.total;
    send(ana.id, [ana.id]);
    expect(costReport(f.handle.db, f.seeded.draftPeriodId).cost.totals.total).toBe(before);
  });

  it('does not offer a nurse already floated off for the next float', () => {
    everyoneComesIn();
    const ana = f.rns[2]!;
    send(ana.id, [ana.id]);
    const view = floatOrderFor(f.handle.db, request([ana.id]));
    expect(view.order.some((p) => p.nurseId === ana.id)).toBe(false);
    expect(view.excluded.some((e) => e.nurseId === ana.id)).toBe(false);
  });
});
