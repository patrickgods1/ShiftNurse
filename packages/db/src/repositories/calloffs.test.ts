/**
 * Repository tests for call-offs and the call log: reporting, covering, cancelling, and the
 * attempts recorded against each.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { ids } from '../ids.js';
import * as s from '../schema.js';
import {
  cancelCallOff,
  getCallOff,
  lastCalledAt,
  listCallAttempts,
  listCallOffsForUnit,
  logCallAttempt,
  markCallOffCovered,
  markCallOffUncovered,
  openCallOffForAssignment,
  reportCallOff,
} from './calloffs.js';
import { createShiftType, createUnit } from './config.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let periodId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: `E${Math.random().toString().slice(2, 8)}`,
      firstName,
      lastName: 'Nurse',
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
  ).id;
}

function mkAssignment(nurseId: string, date: IsoDate) {
  return createAssignment(handle.db, { periodId, nurseId, shiftTypeId, date }, ACTOR);
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const ruleSet = saveRuleSet(
    handle.db,
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
      configs: [
        {
          ruleId: 'min-rest-between-shifts',
          enabled: true,
          params: { minRestHours: 10, onCallCountsAsWork: false },
        },
      ],
    },
    ACTOR,
  );
  periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('call-offs', () => {
  it('reports a call-off, marks it covered with a replacement assignment, and audits both steps', () => {
    const nurseId = mkNurse('Ada');
    const replacementNurse = mkNurse('Grace');
    const original = mkAssignment(nurseId, isoDate('2026-01-16'));

    const callOff = reportCallOff(handle.db, original.id, ACTOR, 'Sick');
    expect(callOff.status).toBe('open');

    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-16'));
    const covered = markCallOffCovered(handle.db, callOff.id, replacement.id, ACTOR);
    expect(covered.status).toBe('covered');
    expect(covered.replacementAssignmentId).toBe(replacement.id);

    const callOffHistory = auditHistoryFor(handle.db, 'call_off', callOff.id);
    expect(callOffHistory.map((h) => h.action)).toEqual(
      expect.arrayContaining(['call_off', 'backfill']),
    );
  });

  it('excludes covered and cancelled call-offs from the open list', () => {
    const nurseId = mkNurse('Ada');
    const a1 = mkAssignment(nurseId, isoDate('2026-01-16'));
    const a2 = mkAssignment(nurseId, isoDate('2026-01-17'));
    const a3 = mkAssignment(nurseId, isoDate('2026-01-18'));

    const open = reportCallOff(handle.db, a1.id, ACTOR);
    const toCover = reportCallOff(handle.db, a2.id, ACTOR);
    const toCancel = reportCallOff(handle.db, a3.id, ACTOR);

    const replacementNurse = mkNurse('Grace');
    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-17'));
    markCallOffCovered(handle.db, toCover.id, replacement.id, ACTOR);
    cancelCallOff(handle.db, toCancel.id, ACTOR, 'Nurse turned up after all');

    const openList = listCallOffsForUnit(handle.db, unitId, { status: 'open' });
    expect(openList.map((c) => c.id)).toEqual([open.id]);
  });

  it("lists a unit's call-offs by date range and status", () => {
    const nurseId = mkNurse('Ada');
    const a1 = mkAssignment(nurseId, isoDate('2026-01-16'));
    const a2 = mkAssignment(nurseId, isoDate('2026-01-20'));
    const a3 = mkAssignment(nurseId, isoDate('2026-01-25'));

    const inRange1 = reportCallOff(handle.db, a1.id, ACTOR);
    const inRange2 = reportCallOff(handle.db, a2.id, ACTOR);
    const outOfRange = reportCallOff(handle.db, a3.id, ACTOR);
    cancelCallOff(handle.db, inRange2.id, ACTOR, 'Logged in error');

    const inRangeOpen = listCallOffsForUnit(handle.db, unitId, {
      status: 'open',
      start: isoDate('2026-01-15'),
      end: isoDate('2026-01-21'),
    });
    expect(inRangeOpen.map((c) => c.id)).toEqual([inRange1.id]);

    const wholeRange = listCallOffsForUnit(handle.db, unitId, {
      start: isoDate('2026-01-15'),
      end: isoDate('2026-01-21'),
    });
    expect(wholeRange.map((c) => c.id).sort()).toEqual([inRange1.id, inRange2.id].sort());

    expect(listCallOffsForUnit(handle.db, unitId).map((c) => c.id)).not.toContain(undefined);
    expect(
      listCallOffsForUnit(handle.db, unitId)
        .map((c) => c.id)
        .sort(),
    ).toEqual([inRange1.id, inRange2.id, outOfRange.id].sort());
  });

  it('refuses to cancel a call-off without a reason, and leaves it open for a real one', () => {
    const nurseId = mkNurse('Ada');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    expect(() => cancelCallOff(handle.db, co.id, ACTOR, '')).toThrow(/requires a reason/);
    // The blank attempt must not have flipped the status — otherwise the manager's very next
    // try, this time with a real reason, would fail with "is cancelled, not open".
    expect(getCallOff(handle.db, co.id)?.status).toBe('open');
    expect(cancelCallOff(handle.db, co.id, ACTOR, 'Logged in error').status).toBe('cancelled');
  });

  it('refuses to log a call against a covered call-off', () => {
    const nurseId = mkNurse('Ada');
    const replacementNurse = mkNurse('Grace');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-16'));
    markCallOffCovered(handle.db, co.id, replacement.id, ACTOR);

    expect(() => logCallAttempt(handle.db, co.id, replacementNurse, 'accepted', ACTOR)).toThrow(
      /is covered, not open/,
    );
  });

  it('refuses to mark a call-off uncovered without a reason, and leaves it open for a real one', () => {
    const nurseId = mkNurse('Ada');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    expect(() => markCallOffUncovered(handle.db, co.id, ACTOR, '')).toThrow(/requires a reason/);
    // Same guard as cancellation: a blank attempt must not have flipped the status, or a
    // retry with a real reason would fail with "is uncovered, not open".
    expect(getCallOff(handle.db, co.id)?.status).toBe('open');
    expect(
      markCallOffUncovered(handle.db, co.id, ACTOR, 'Nobody could be reached in time').status,
    ).toBe('uncovered');
  });

  it('refuses to mark an already-cancelled call-off uncovered', () => {
    const nurseId = mkNurse('Ada');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    cancelCallOff(handle.db, co.id, ACTOR, 'Logged in error');

    expect(() =>
      markCallOffUncovered(handle.db, co.id, ACTOR, 'Nobody could be reached in time'),
    ).toThrow(/is cancelled, not open/);
  });

  it('refuses to mark an already-covered call-off uncovered', () => {
    const nurseId = mkNurse('Ada');
    const replacementNurse = mkNurse('Grace');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-16'));
    markCallOffCovered(handle.db, co.id, replacement.id, ACTOR);

    expect(() =>
      markCallOffUncovered(handle.db, co.id, ACTOR, 'Nobody could be reached in time'),
    ).toThrow(/is covered, not open/);
  });

  it('refuses to mark an already-covered call-off covered again', () => {
    const nurseId = mkNurse('Ada');
    const replacementNurse = mkNurse('Grace');
    const anotherNurse = mkNurse('Priya');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    const co = reportCallOff(handle.db, a.id, ACTOR);
    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-16'));
    markCallOffCovered(handle.db, co.id, replacement.id, ACTOR);
    const another = mkAssignment(anotherNurse, isoDate('2026-01-17'));

    expect(() => markCallOffCovered(handle.db, co.id, another.id, ACTOR)).toThrow(
      /is covered, not open/,
    );
  });

  it('finds the open call-off for an assignment', () => {
    const nurseId = mkNurse('Ada');
    const a = mkAssignment(nurseId, isoDate('2026-01-16'));
    expect(openCallOffForAssignment(handle.db, a.id)).toBeUndefined();

    const co = reportCallOff(handle.db, a.id, ACTOR);
    expect(openCallOffForAssignment(handle.db, a.id)?.id).toBe(co.id);

    cancelCallOff(handle.db, co.id, ACTOR, 'Logged in error');
    expect(openCallOffForAssignment(handle.db, a.id)).toBeUndefined();
  });
});

describe('call attempts', () => {
  function insertAttempt(callOffId: string, nurseId: string, attemptedAt: number): void {
    // Inserted directly so the timestamps are controlled; `logCallAttempt` stamps Date.now().
    handle.db
      .insert(s.callAttempt)
      .values({ id: ids.callAttempt(), callOffId, nurseId, attemptedAt, outcome: 'no_answer' })
      .run();
  }

  it('lists every attempt made for a call-off', () => {
    const nurseId = mkNurse('Covering');
    const assignment = mkAssignment(nurseId, isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);

    logCallAttempt(handle.db, callOff.id, nurseId, 'no_answer', ACTOR);
    logCallAttempt(handle.db, callOff.id, nurseId, 'declined', ACTOR);
    logCallAttempt(handle.db, callOff.id, nurseId, 'accepted', ACTOR);

    // Newest first, like the audit history — the accepted call is the one you want at the top.
    expect(listCallAttempts(handle.db, callOff.id).map((a) => a.outcome)).toEqual([
      'accepted',
      'declined',
      'no_answer',
    ]);
  });

  it('returns the most recent attempt per nurse, not the first', () => {
    // This is what stops the replacement finder phoning the same three people every time.
    const phoned = mkNurse('Phoned');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);

    const earlier = Date.parse('2026-01-10T08:00:00Z');
    const later = Date.parse('2026-01-14T08:00:00Z');
    insertAttempt(callOff.id, phoned, earlier);
    insertAttempt(callOff.id, phoned, later);

    const last = lastCalledAt(handle.db, unitId, isoDate('2026-01-01'));
    expect(last.get(phoned)).toBe(later);
  });

  it('omits nurses who were never called', () => {
    const phoned = mkNurse('Phoned');
    const quiet = mkNurse('Quiet');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);
    insertAttempt(callOff.id, phoned, Date.parse('2026-01-10T08:00:00Z'));

    const last = lastCalledAt(handle.db, unitId, isoDate('2026-01-01'));
    expect(last.has(phoned)).toBe(true);
    expect(last.has(quiet)).toBe(false);
  });

  it('ignores attempts older than the lookback date', () => {
    const phoned = mkNurse('Phoned');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);
    insertAttempt(callOff.id, phoned, Date.parse('2025-06-01T08:00:00Z'));

    expect(lastCalledAt(handle.db, unitId, isoDate('2026-01-01')).has(phoned)).toBe(false);
  });
});
