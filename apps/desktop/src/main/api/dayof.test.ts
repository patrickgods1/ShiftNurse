/**
 * Backfilling a call-off from the Today screen. The replacement is re-ranked in main right before
 * the write, so a nurse who is not eligible is refused whatever the screen showed, and on a
 * published schedule the swap of rows goes into the change log as a backfill — the record staff
 * see of who covered whom.
 */

import { addDays, isoDate, shiftsAround } from '@shiftnurse/core';
import {
  auditHistoryFor,
  createNurse,
  createNurseUnit,
  createPeriod,
  createUnit,
  getAssignment,
  getCallOff,
  getPeriod,
  listAcuityTiersForUnit,
  listAssignmentsForPeriod,
  listCensusForecastsInRange,
  listChanges,
  listNursesForUnit,
  listPeriodsForUnit,
  listShiftTypesForUnit,
  publishSchedule,
  recordActualCensus,
  updateNurse,
  updateUnit,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTOR } from './context.js';
import { dayOfApi } from './dayof.js';
import { floatOutApi } from './float-out.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  vi.useRealTimers();
  f.handle.close();
});

describe('a nurse floated to another unit', () => {
  it('leaves a nurse floated to another unit off the shift’s roster on Today', () => {
    const date = addDays(f.seeded.draftStart, 4);
    const slot = () =>
      dayOfApi(f.handle.db)
        .today(f.seeded.unitId, date)
        .shifts.find((s) => s.date === date && s.shiftType.id === f.day.id)!;
    // Nobody is on yet: build the shift, read it, then float the first nurse off.
    for (const nurse of f.rns) updateNurse(f.handle.db, nurse.id, { isFloatEligible: true }, ACTOR);
    for (const nurse of f.rns) {
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date,
      });
    }
    const before = slot();
    expect(before.roster).toHaveLength(f.rns.length);
    const request = {
      periodId: f.seeded.draftPeriodId,
      date,
      shiftTypeId: f.day.id,
      role: 'RN' as const,
      volunteers: [],
    };
    const first = floatOutApi(f.handle.db).order(request).order[0]!;
    floatOutApi(f.handle.db).send({
      ...request,
      nurseId: first.nurseId,
      toUnit: '5 East',
      reason: 'Floated to 5 East',
    });

    const after = slot();
    expect(after.roster.map((r) => r.nurse.id)).not.toContain(first.nurseId);
    expect(after.roster).toHaveLength(f.rns.length - 1);
    expect(after.staffing.byRole.RN.staffed).toBe(before.staffing.byRole.RN.staffed - 1);
  });
});

describe('a call-off against a floated shift', () => {
  it('refuses a call-off for a nurse already floated off, and leaves her shift alone', () => {
    const date = addDays(f.seeded.draftStart, 4);
    for (const nurse of f.rns) updateNurse(f.handle.db, nurse.id, { isFloatEligible: true }, ACTOR);
    for (const nurse of f.rns) {
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date,
      });
    }
    const request = {
      periodId: f.seeded.draftPeriodId,
      date,
      shiftTypeId: f.day.id,
      role: 'RN' as const,
      volunteers: [],
    };
    const first = floatOutApi(f.handle.db).order(request).order[0]!;
    floatOutApi(f.handle.db).send({
      ...request,
      nurseId: first.nurseId,
      toUnit: '5 East',
      reason: 'Floated to 5 East',
    });
    const row = listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).find(
      (a) => a.nurseId === first.nurseId && a.date === date,
    )!;

    expect(() => dayOfApi(f.handle.db).reportCallOff(row.id, 'sick')).toThrow(
      /was floated to 5 East for this shift; she is not on this unit's shift/,
    );
    expect(getAssignment(f.handle.db, row.id)).toMatchObject({ floatedTo: '5 East' });
  });
});

describe('a backfill for a nurse floated after her call-off', () => {
  it('refuses to backfill a call-off whose nurse was floated off', () => {
    const date = addDays(f.seeded.draftStart, 4);
    for (const nurse of f.rns) updateNurse(f.handle.db, nurse.id, { isFloatEligible: true }, ACTOR);
    for (const nurse of f.rns) {
      scheduleApi(f.handle.db).createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: nurse.id,
        shiftTypeId: f.day.id,
        date,
      });
    }
    const request = {
      periodId: f.seeded.draftPeriodId,
      date,
      shiftTypeId: f.day.id,
      role: 'RN' as const,
      volunteers: [],
    };
    const first = floatOutApi(f.handle.db).order(request).order[0]!;
    const row = listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).find(
      (a) => a.nurseId === first.nurseId && a.date === date,
    )!;
    const callOff = dayOfApi(f.handle.db).reportCallOff(row.id, 'sick');
    floatOutApi(f.handle.db).send({
      ...request,
      nurseId: first.nurseId,
      toUnit: '5 East',
      reason: 'Floated to 5 East',
    });
    const other = f.rns.find((n) => n.id !== first.nurseId)!;

    expect(() => dayOfApi(f.handle.db).backfill(callOff.id, other.id)).toThrow(/floated to/);
    expect(getAssignment(f.handle.db, row.id)).toMatchObject({ floatedTo: '5 East' });
  });
});

describe('backfilling a call-off', () => {
  it('refuses a replacement who is already working that shift', () => {
    const grid = scheduleApi(f.handle.db);
    const date = addDays(f.seeded.draftStart, 4);
    const [ann, bea] = [f.rns[0]!, f.rns[1]!];
    const absent = grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: bea.id,
      shiftTypeId: f.day.id,
      date,
    });

    const dayOf = dayOfApi(f.handle.db);
    const callOff = dayOf.reportCallOff(absent.id, 'sick');
    expect(() => dayOf.backfill(callOff.id, bea.id)).toThrow(/not eligible/);
    // Ann's shift is untouched: nothing was written.
    expect(
      listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).map((a) => a.id),
    ).toContain(absent.id);
  });

  it('writes the cover into a published schedule’s change log as a backfill', () => {
    const grid = scheduleApi(f.handle.db);
    const absent = grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 4),
    });
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);

    const dayOf = dayOfApi(f.handle.db);
    const callOff = dayOf.reportCallOff(absent.id, 'sick');
    const cover = dayOf.replacements(callOff.id).candidates[0];
    expect(cover).toBeDefined();
    const result = dayOf.backfill(callOff.id, cover!.nurseId);

    expect(result.callOff.status).toBe('covered');
    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes.map((c) => [c.kind, c.source])).toEqual([
      ['added', 'backfill'],
      ['removed', 'backfill'],
    ]);
    expect(changes[1]!.nurseId).toBe(f.rns[0]!.id);
    expect(changes[0]!.reason).toMatch(/^Call-off: /);
  });
});

describe('the call-off workflow on a published schedule', () => {
  const grid = () => scheduleApi(f.handle.db);
  const dayOf = () => dayOfApi(f.handle.db);

  /** Ann is on the day shift on day 4; the schedule is published; she phones in sick. */
  function annCallsInSick() {
    const date = addDays(f.seeded.draftStart, 4);
    const absent = grid().createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
    const callOff = dayOf().reportCallOff(absent.id, 'sick', 12);
    return { date, absent, callOff };
  }

  it('hands Ann’s shift to the nurse who said yes, logs the call, and explains it in the change log', () => {
    const { date, absent, callOff } = annCallsInSick();
    expect(callOff.status).toBe('open');
    expect(callOff.paidSickHours).toBe(12);

    const [first, second] = dayOf().replacements(callOff.id).candidates;
    expect(second).toBeDefined();
    // The manager rang the first choice, who declined, and the second said yes.
    dayOf().logCall(callOff.id, first!.nurseId, 'declined', 'at her daughter’s recital');
    const result = dayOf().backfill(callOff.id, second!.nurseId, 'Came in early');

    expect(result.assignment).toMatchObject({
      nurseId: second!.nurseId,
      shiftTypeId: f.day.id,
      date,
      source: 'callout',
    });
    expect(getAssignment(f.handle.db, absent.id)).toBeUndefined();
    expect(result.callOff).toMatchObject({
      status: 'covered',
      replacementAssignmentId: result.assignment.id,
    });

    const log = dayOf().callLog(callOff.id);
    expect(log.map((a) => [a.nurseId, a.outcome])).toEqual([
      [second!.nurseId, 'accepted'],
      [first!.nurseId, 'declined'],
    ]);

    const changes = listChanges(f.handle.db, f.seeded.draftPeriodId);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.source === 'backfill')).toBe(true);
    expect(changes.every((c) => c.reason?.includes('sick'))).toBe(true);
  });

  it('refuses to backfill a shift that carries a recorded holdover and changes nothing', () => {
    const { absent, callOff } = annCallsInSick();
    dayOf().recordHoldover({ assignmentId: absent.id, minutes: 75, mandated: false });
    const [first] = dayOf().replacements(callOff.id).candidates;

    expect(() => dayOf().backfill(callOff.id, first!.nurseId)).toThrow(/75-minute holdover/);
    expect(getAssignment(f.handle.db, absent.id)?.holdoverMinutes).toBe(75);
    expect(getCallOff(f.handle.db, callOff.id)?.status).toBe('open');
  });

  it('refuses to backfill with a nurse who is not eligible and leaves the call-off open', () => {
    const { absent, callOff } = annCallsInSick();
    const eligible = new Set(
      dayOf()
        .replacements(callOff.id)
        .candidates.map((c) => c.nurseId),
    );
    // Ann herself is the absent nurse: never a candidate for her own shift.
    expect(eligible.has(f.rns[0]!.id)).toBe(false);
    const changesBefore = listChanges(f.handle.db, f.seeded.draftPeriodId).length;

    expect(() => dayOf().backfill(callOff.id, f.rns[0]!.id)).toThrow(/not eligible/);
    expect(() => dayOf().backfill(callOff.id, 'nurse-that-does-not-exist')).toThrow(
      'That nurse was not found. Reload the page.',
    );

    expect(getCallOff(f.handle.db, callOff.id)?.status).toBe('open');
    expect(getAssignment(f.handle.db, absent.id)).toBeDefined();
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toHaveLength(changesBefore);
  });

  it('records every kind of unsuccessful call, newest first, and refuses to log a yes as a call', () => {
    const { callOff } = annCallsInSick();
    const [a, b, c, d] = dayOf().replacements(callOff.id).candidates;
    dayOf().logCall(callOff.id, a!.nurseId, 'no_answer');
    dayOf().logCall(callOff.id, b!.nurseId, 'left_message', 'voicemail');
    dayOf().logCall(callOff.id, c!.nurseId, 'declined');
    dayOf().logCall(callOff.id, d!.nurseId, 'ineligible', 'on vacation');

    expect(
      dayOf()
        .callLog(callOff.id)
        .map((x) => [x.nurseId, x.outcome, x.notes]),
    ).toEqual([
      [d!.nurseId, 'ineligible', 'on vacation'],
      [c!.nurseId, 'declined', undefined],
      [b!.nurseId, 'left_message', 'voicemail'],
      [a!.nurseId, 'no_answer', undefined],
    ]);
    // A yes is recorded by backfill, which also writes the shift; never as a bare call.
    expect(() => dayOf().logCall(callOff.id, a!.nurseId, 'accepted' as never)).toThrow(
      /recorded through backfill/,
    );
    expect(dayOf().callLog(callOff.id)).toHaveLength(4);
  });

  it('marks a shift nobody could cover as uncovered, with the reason on record', () => {
    const { absent, callOff } = annCallsInSick();
    expect(() => dayOf().markUncovered(callOff.id, '  ')).toThrow(/requires a reason/);
    expect(getCallOff(f.handle.db, callOff.id)?.status).toBe('open');

    const done = dayOf().markUncovered(callOff.id, 'Rang everyone on the list; running one short');
    expect(done.status).toBe('uncovered');
    // Ann's row stays: nothing was replaced.
    expect(getAssignment(f.handle.db, absent.id)).toBeDefined();
    const history = auditHistoryFor(f.handle.db, 'call_off', callOff.id);
    expect(history[0]?.reason).toBe('Rang everyone on the list; running one short');

    // A decided call-off takes no further calls, replacements or backfills.
    expect(() => dayOf().replacements(callOff.id)).toThrow(/uncovered, not open/);
    expect(() => dayOf().logCall(callOff.id, f.rns[1]!.id, 'declined')).toThrow(/not open/);
    expect(() => dayOf().backfill(callOff.id, f.rns[1]!.id)).toThrow(/not open/);
  });

  it('cancelling a call-off because Ann turned up leaves her on the shift and the schedule untouched', () => {
    const { date, absent, callOff } = annCallsInSick();
    const changesBefore = listChanges(f.handle.db, f.seeded.draftPeriodId).length;
    expect(() => dayOf().cancelCallOff(callOff.id, '')).toThrow(/requires a reason/);

    const done = dayOf().cancelCallOff(callOff.id, 'Ann turned up after all');
    expect(done.status).toBe('cancelled');

    // Reporting did not remove her row, so cancelling has nothing to put back.
    expect(getAssignment(f.handle.db, absent.id)).toMatchObject({
      nurseId: f.rns[0]!.id,
      date,
      source: 'manual',
    });
    expect(listChanges(f.handle.db, f.seeded.draftPeriodId)).toHaveLength(changesBefore);
    expect(auditHistoryFor(f.handle.db, 'call_off', callOff.id)[0]?.reason).toBe(
      'Ann turned up after all',
    );
    expect(() => dayOf().cancelCallOff(callOff.id, 'again')).toThrow(/cancelled, not open/);
    // She can phone in sick again later: the cancelled one no longer blocks a new report.
    expect(dayOf().reportCallOff(absent.id, 'relapse').status).toBe('open');
  });

  it('refuses a second call-off while one is still open for the same shift', () => {
    const { absent } = annCallsInSick();
    expect(() => dayOf().reportCallOff(absent.id, 'again')).toThrow(
      'A call-off is already open for this assignment',
    );
    expect(dayOf().callOffs(f.seeded.unitId, absent.date, absent.date)).toHaveLength(1);
  });

  it('refuses a call-off against an assignment that does not exist', () => {
    expect(() => dayOf().reportCallOff('no-such-shift')).toThrow(/not found/);
  });
});

describe('recording a holdover day-of', () => {
  const dayOf = () => dayOfApi(f.handle.db);

  function publishedShift() {
    const a = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 4),
    });
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
    return a;
  }

  it('keeps a volunteered holdover on the shift for the next read', () => {
    const a = publishedShift();
    dayOf().recordHoldover({ assignmentId: a.id, minutes: 45, mandated: false });
    expect(getAssignment(f.handle.db, a.id)).toMatchObject({
      holdoverMinutes: 45,
      holdoverMandated: false,
    });
    const listed = listAssignmentsForPeriod(f.handle.db, f.seeded.draftPeriodId).find(
      (x) => x.id === a.id,
    );
    expect(listed?.holdoverMinutes).toBe(45);
  });

  it('refuses a required holdover with no reason and records nothing', () => {
    const a = publishedShift();
    const audited = auditHistoryFor(f.handle.db, 'assignment', a.id).length;
    expect(() =>
      dayOf().recordHoldover({ assignmentId: a.id, minutes: 60, mandated: true }),
    ).toThrow(/reason/);
    expect(auditHistoryFor(f.handle.db, 'assignment', a.id)).toHaveLength(audited);
    expect(getAssignment(f.handle.db, a.id)).not.toHaveProperty('holdoverMinutes');
  });
});

describe('the live staffing re-check when the census changes', () => {
  it('turns a fully staffed day shift short when the actual census comes in higher', () => {
    const date = addDays(f.seeded.draftStart, 4);
    const grid = scheduleApi(f.handle.db);
    // The floors also ask for an LPN and a CNA, so the only thing that changes below is the RN count.
    const others = ['LPN', 'CNA'].map(
      (role) =>
        listNursesForUnit(f.handle.db, f.seeded.unitId).find((n) => n.active && n.role === role)!,
    );
    for (const rn of [...f.rns.slice(0, 6), ...others]) {
      grid.createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: rn.id,
        shiftTypeId: f.day.id,
        date,
      });
    }
    const routine = listAcuityTiersForUnit(f.handle.db, f.seeded.unitId).find(
      (t) => t.name === 'Routine',
    )!;
    const forecast = listCensusForecastsInRange(f.handle.db, f.seeded.unitId, date, date).find(
      (c) => c.shiftTypeId === f.day.id,
    )!;
    const dayShift = () =>
      dayOfApi(f.handle.db)
        .today(f.seeded.unitId, date)
        .shifts.find((s) => s.date === date && s.shiftType.id === f.day.id)!;

    // 25 routine patients at the scenario's 1:5 RN ratio need 5 RNs; six are on.
    recordActualCensus(f.handle.db, forecast.id, 25, { [routine.id]: 25 }, ACTOR);
    expect(dayShift().staffing).toMatchObject({ basis: 'actual', census: 25, short: false });
    expect(dayShift().staffing.byRole.RN).toMatchObject({ required: 5, staffed: 6, shortfall: 0 });
    expect(dayShift().roster).toHaveLength(8);

    // The ward fills up: 35 patients need 7 RNs, and the page now says one short.
    recordActualCensus(f.handle.db, forecast.id, 35, { [routine.id]: 35 }, ACTOR);
    const after = dayShift().staffing;
    expect(after).toMatchObject({ basis: 'actual', census: 35, short: true, ratioBreached: true });
    expect(after.byRole.RN).toMatchObject({ required: 7, staffed: 6, shortfall: 1 });
  });

  it('shows an open call-off against the nurse’s row on that day’s roster', () => {
    const date = addDays(f.seeded.draftStart, 4);
    const absent = scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    const callOff = dayOfApi(f.handle.db).reportCallOff(absent.id, 'sick');
    const summary = dayOfApi(f.handle.db).today(f.seeded.unitId, date);
    const row = summary.shifts
      .find((s) => s.date === date && s.shiftType.id === f.day.id)!
      .roster.find((r) => r.assignment.id === absent.id);
    expect(row?.callOff?.id).toBe(callOff.id);
    expect(summary.openCallOffs.map((c) => c.callOff.id)).toEqual([callOff.id]);
  });
});

describe('the overtime call order', () => {
  /** Every other RN carries 36h Mon-Wed of the call-off week, so Thursday's 12h is overtime. */
  function overtimeCall() {
    const grid = scheduleApi(f.handle.db);
    const monday = f.seeded.draftStart;
    const put = (
      nurseId: string,
      date: string,
      isOvertime = false,
      shiftTypeId = f.day.id,
      periodId = f.seeded.draftPeriodId,
    ) =>
      grid.createAssignment({
        periodId,
        nurseId,
        shiftTypeId,
        date: isoDate(date),
        isOvertime,
      });
    const date = addDays(monday, 4);
    const absent = put(f.rns[0]!.id, date);
    return { put, date, absent, monday };
  }

  it('mandates overtime most junior first, with their last overtime shown, once the unit chose rosters', () => {
    const { put, absent, monday } = overtimeCall();
    const others = f.rns.slice(1);
    for (const n of others) for (const d of [0, 1, 2]) put(n.id, addDays(monday, d));
    // Overtime history, well before the seeded history periods so no row doubles a seeded shift.
    // They sit in a schedule of their own: a shift cannot be dated outside the one that holds it.
    const draft = getPeriod(f.handle.db, f.seeded.draftPeriodId)!;
    const history = createPeriod(
      f.handle.db,
      {
        unitId: f.seeded.unitId,
        name: 'Old overtime',
        startDate: addDays(monday, -130),
        endDate: addDays(monday, -95),
        ruleSetId: draft.ruleSetId,
        ruleSetVersion: draft.ruleSetVersion,
      },
      ACTOR,
    );
    for (const [i, n] of others.entries()) {
      put(n.id, addDays(monday, -100 - i), true, f.day.id, history.id);
    }
    const dayOf = dayOfApi(f.handle.db);
    const callOff = dayOf.reportCallOff(absent.id, 'sick');

    updateUnit(f.handle.db, f.seeded.unitId, { overtimeOrder: 'roster' }, ACTOR);
    const overtime = dayOf
      .replacements(callOff.id)
      .candidates.filter((c) => c.payTier === 'overtime');
    // Nobody volunteered, so the mandated roster runs most junior first; the dates still show.
    expect(overtime.length).toBeGreaterThan(1);
    const juniorFirst = others
      .filter((n) => overtime.some((c) => c.nurseId === n.id))
      .sort((x, y) => y.seniorityDate.localeCompare(x.seniorityDate) || x.id.localeCompare(y.id))
      .map((n) => n.id);
    expect(overtime.map((c) => c.nurseId)).toEqual(juniorFirst);
    expect(overtime.every((c) => c.lastOvertimeOn !== undefined)).toBe(true);
  });
});

describe('the Today clock', () => {
  /** Pins the host clock to `date` at hh:mm local; tests run under TZ=America/New_York. */
  function setClock(date: string, hh: number, mm: number) {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(y, m - 1, d, hh, mm));
  }

  it('shows tomorrow’s first shift with a nurse floating in for that day only, late in the evening', () => {
    const d = addDays(f.seeded.draftStart, 10);
    setClock(d, 23, 59);
    const around = shiftsAround(
      listShiftTypesForUnit(f.handle.db, f.seeded.unitId),
      d,
      23 * 60 + 59,
    );
    // 23:59 is after every start on d, so the next start is tomorrow's first shift.
    expect(around.next?.date).toBe(addDays(d, 1));
    const west = createUnit(
      f.handle.db,
      {
        name: '5 West',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const fran = createNurse(
      f.handle.db,
      {
        unitId: west.id,
        employeeId: 'W-9',
        firstName: 'Fran',
        lastName: 'Float',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: false,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    );
    createNurseUnit(
      f.handle.db,
      {
        nurseId: fran.id,
        unitId: f.seeded.unitId,
        startDate: addDays(d, 1),
        endDate: addDays(d, 1),
      },
      ACTOR,
    );
    scheduleApi(f.handle.db).createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: fran.id,
      shiftTypeId: around.next!.shiftTypeId,
      date: addDays(d, 1),
    });

    const summary = dayOfApi(f.handle.db).today(f.seeded.unitId, d);
    const next = summary.shifts.find((s) => s.status === 'next')!;
    expect(next.date).toBe(addDays(d, 1));
    expect(next.roster.map((r) => r.nurse.id)).toContain(fran.id);
  });

  it('tags no shift as running when looking at another day', () => {
    const d = addDays(f.seeded.draftStart, 10);
    setClock(d, 8, 0);
    // 08:00 is inside the fixture's 07:00-19:00 day shift.
    expect(f.day.startTime).toBe('07:00');
    expect(f.day.durationHours).toBe(12);
    const api = dayOfApi(f.handle.db);
    expect(
      api.today(f.seeded.unitId, addDays(d, 1)).shifts.every((s) => s.status === 'other'),
    ).toBe(true);
    expect(
      api
        .today(f.seeded.unitId, d)
        .shifts.some((s) => s.shiftType.id === f.day.id && s.status === 'current'),
    ).toBe(true);
  });

  it('files last night’s shift under the period it was worked in, on a new period’s first morning', () => {
    const start = f.seeded.draftStart;
    const eve = addDays(start, -1);
    const previous = listPeriodsForUnit(f.handle.db, f.seeded.unitId).find(
      (p) => p.endDate === eve,
    );
    expect(previous).toBeDefined();
    // 03:00 on the new period's first day: the 19:00 night that began yesterday is still running.
    expect(f.night.startTime).toBe('19:00');
    expect(f.night.durationHours).toBe(12);
    setClock(start, 3, 0);

    const shifts = dayOfApi(f.handle.db).today(f.seeded.unitId, start).shifts;
    const lastNight = shifts.find((s) => s.shiftType.id === f.night.id && s.date === eve);
    expect(lastNight?.period?.id).toBe(previous!.id);
    const todays = shifts.filter((s) => s.date === start);
    expect(todays.length).toBeGreaterThan(0);
    for (const s of todays) expect(s.period?.id).toBe(f.seeded.draftPeriodId);
  });
});
