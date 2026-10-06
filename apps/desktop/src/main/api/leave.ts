/**
 * Late time off: approve a request and cover the shifts it frees, as one decision.
 *
 * Requests belong before the schedule is built. Those that come after it should not mean
 * regenerating: two variations of the same unit differ by hundreds of shifts, so regenerating to
 * fill one nurse's two days reshuffles everyone else's schedule. Instead the manager approves and
 * picks who takes each freed shift from the same ranked, rule-checked list the Today page uses
 * for call-offs — simulated with the leave already approved, so every name offered is legal.
 *
 * On a published schedule approving used to leave the nurse rostered on approved leave (only a
 * draft lifts shifts); here those shifts come off too, under the manager's reason and in the
 * change log, with their cover added in the same transaction.
 */

import {
  type Assignment,
  findReplacements,
  type Id,
  type ReplacementCandidate,
  type TimeOffRequest,
} from '@shiftnurse/core';
import {
  approveTimeOffAndLiftAssignments,
  createAssignment,
  type DbLike,
  deleteAssignment,
  getTimeOffRequest,
  listAssignmentsForPeriod,
  type ShiftNurseDb,
} from '@shiftnurse/db';
import type { LeaveCover, LeaveCoverOption } from '../../shared/api.js';
import { ACTOR, buildConflictInput } from './context.js';
import { editSchedule } from './schedule.js';

const MAX_CANDIDATES = 6;

function requestOrThrow(db: DbLike, requestId: Id): TimeOffRequest {
  const request = getTimeOffRequest(db, requestId);
  if (!request) throw new Error('That time-off request no longer exists');
  if (request.status !== 'pending') throw new Error(`That request is already ${request.status}`);
  return request;
}

/** The nurse's shifts in this period that the leave covers: what approving would free. */
function freedShifts(db: DbLike, periodId: Id, request: TimeOffRequest): Assignment[] {
  return listAssignmentsForPeriod(db, periodId).filter(
    (a) =>
      a.nurseId === request.nurseId && a.date >= request.startDate && a.date <= request.endDate,
  );
}

export function coverOptions(db: DbLike, periodId: Id, requestId: Id): LeaveCoverOption[] {
  const request = requestOrThrow(db, requestId);
  const input = buildConflictInput(db, periodId);
  // Judged with the leave approved, so a candidate is legal around it.
  const timeOff = input.timeOff.map((r) =>
    r.id === requestId ? { ...r, status: 'approved' as const } : r,
  );
  return freedShifts(db, periodId, request).map((assignment) => {
    const report = findReplacements({
      ...input,
      timeOff,
      absentAssignmentId: assignment.id,
      lastCalledAt: {},
    });
    return {
      assignment,
      shortfall: report.shortfall,
      candidates: report.candidates.slice(0, MAX_CANDIDATES).map((c: ReplacementCandidate) => ({
        nurseId: c.nurseId,
        label: c.label,
        payTier: c.payTier,
        overtime: c.assignment.isOvertime,
      })),
    };
  });
}

export function approveAndCover(
  db: ShiftNurseDb,
  periodId: Id,
  requestId: Id,
  reason: string | undefined,
  covers: readonly LeaveCover[],
): { request: TimeOffRequest; covered: Assignment[] } {
  // Checked before anything is written: main is the judge, not the dialog that offered them.
  const options = coverOptions(db, periodId, requestId);
  for (const cover of covers) {
    const option = options.find((o) => o.assignment.id === cover.assignmentId);
    const candidate = option?.candidates.find((c) => c.nurseId === cover.nurseId);
    if (!option || !candidate) {
      throw new Error('That nurse cannot cover that shift under the unit’s rules; pick another');
    }
  }
  // The nurse asked for the leave, so a unit that requires consent for manager-initiated
  // changes does not ask for it again here.
  return editSchedule(db, periodId, reason, 'time_off', (tx, log) => {
    const { request, lifted } = approveTimeOffAndLiftAssignments(tx, requestId, ACTOR, reason);
    const freed = new Map(lifted.map((a) => [a.id, a]));
    // A published period's shifts are not lifted by approval; they come off here, logged.
    for (const a of options.map((o) => o.assignment)) {
      if (freed.has(a.id)) continue;
      deleteAssignment(tx, a.id, ACTOR, reason);
      freed.set(a.id, a);
    }
    for (const a of freed.values()) log({ kind: 'removed', assignment: a, before: a });
    const covered: Assignment[] = [];
    for (const cover of covers) {
      const gone = freed.get(cover.assignmentId);
      if (!gone) continue;
      const option = options.find((o) => o.assignment.id === cover.assignmentId)!;
      const overtime = option.candidates.find((c) => c.nurseId === cover.nurseId)!.overtime;
      const created = createAssignment(
        tx,
        {
          periodId,
          nurseId: cover.nurseId,
          shiftTypeId: gone.shiftTypeId,
          date: gone.date,
          source: 'manual',
          isOvertime: overtime,
        },
        ACTOR,
        reason,
      );
      log({ kind: 'added', assignment: created, after: created });
      covered.push(created);
    }
    return { request, covered };
  });
}
