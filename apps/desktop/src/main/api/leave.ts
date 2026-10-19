/**
 * Late time off: approve a request and cover the shifts it frees, as one decision.
 *
 * Requests belong before the schedule is built. Those that come after it should not mean
 * regenerating: two variations of the same unit differ by hundreds of shifts, so regenerating to
 * fill one nurse's two days reshuffles everyone else's schedule. Instead the manager approves and
 * picks who takes each freed shift from the same ranked, rule-checked list the Today page uses
 * for call-offs — simulated with the leave already approved. Every name offered is legal for its shift alone;
 * approving re-judges the chosen covers together, each with the earlier ones in place, inside the
 * approval's transaction.
 *
 * On a published schedule approving used to leave the nurse rostered on approved leave (only a
 * draft lifts shifts); here those shifts come off too, under the manager's reason and in the
 * change log, with their cover added in the same transaction.
 *
 * A request can span periods (the last days of a published schedule and the first of the next
 * draft). Every non-archived period it touches gives up its shifts in the same transaction, each
 * removal and cover logged in its own period's change log, and a published one among them needs
 * the reason before anything is written: otherwise the posted days stayed rostered under
 * approved leave with no record, and the dialog never mentioned them.
 */

import {
  type Assignment,
  compareDates,
  describeDate,
  findReplacements,
  type Id,
  isFloatedOff,
  type ReplacementCandidate,
  type ReplacementReport,
  type SchedulePeriod,
  type TimeOffRequest,
} from '@shiftnurse/core';
import {
  approveTimeOffAndLiftAssignments,
  createAssignment,
  type DbLike,
  deleteAssignment,
  getNurse,
  getShiftType,
  getTimeOffRequest,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  type ShiftNurseDb,
  transact,
  updateAssignment,
} from '@shiftnurse/db';
import type { LeaveCover, LeaveCoverOption } from '../../shared/api.js';
import { ACTOR, assignmentOrThrow, buildConflictInput, periodOrThrow } from './context.js';
import { openChangeLog } from './schedule.js';

const MAX_CANDIDATES = 6;
const CANNOT_COVER = 'That nurse cannot cover that shift under the unit’s rules; pick another';

function requestOrThrow(db: DbLike, requestId: Id): TimeOffRequest {
  const request = getTimeOffRequest(db, requestId);
  if (!request) throw new Error('That time-off request no longer exists');
  if (request.status !== 'pending') throw new Error(`That request is already ${request.status}`);
  return request;
}

/**
 * The periods whose shifts this leave frees: the anchor (the period the manager decides from)
 * first, then every other period of the same unit the request overlaps, by start date. Archived
 * periods are history and are left alone.
 */
function touchedPeriods(
  db: DbLike,
  anchor: SchedulePeriod,
  request: TimeOffRequest,
): SchedulePeriod[] {
  const others = listPeriodsForUnit(db, anchor.unitId)
    .filter(
      (p) =>
        p.id !== anchor.id &&
        p.status !== 'archived' &&
        compareDates(p.startDate, request.endDate) <= 0 &&
        compareDates(p.endDate, request.startDate) >= 0,
    )
    .sort((a, b) => compareDates(a.startDate, b.startDate));
  return [anchor, ...others];
}

/**
 * The nurse's shifts in this period that the leave covers: what approving would free. A shift she
 * was floated off is not one: she worked it elsewhere, and the row records those hours (D20).
 */
function freedShifts(db: DbLike, periodId: Id, request: TimeOffRequest): Assignment[] {
  return listAssignmentsForPeriod(db, periodId).filter(
    (a) =>
      a.nurseId === request.nurseId &&
      a.date >= request.startDate &&
      a.date <= request.endDate &&
      !isFloatedOff(a),
  );
}

/**
 * Each shift the leave would free, with the ranked replacements judged as if the leave were
 * already approved. This is what the dialog shows; the writer re-derives its own candidates
 * (see `approveAndCover`) because it must judge the live, mid-transaction schedule.
 */
function coverReports(
  db: DbLike,
  periodId: Id,
  requestId: Id,
): { assignment: Assignment; report: ReplacementReport }[] {
  const request = requestOrThrow(db, requestId);
  return touchedPeriods(db, periodOrThrow(db, periodId), request).flatMap((period) => {
    // Each shift is judged against its own period: its roster, rules and neighbours.
    const input = buildConflictInput(db, period.id);
    // Judged with the leave approved, so a candidate is legal around it.
    const timeOff = input.timeOff.map((r) =>
      r.id === requestId ? { ...r, status: 'approved' as const } : r,
    );
    return freedShifts(db, period.id, request).map((assignment) => ({
      assignment,
      report: findReplacements({
        ...input,
        timeOff,
        absentAssignmentId: assignment.id,
        lastCalledAt: {},
      }),
    }));
  });
}

/** The roster name the manager knows, not the call list's label with its licence suffix. */
function nurseName(db: DbLike, nurseId: Id): string {
  const n = getNurse(db, nurseId);
  return n ? `${n.firstName} ${n.lastName}` : 'Another nurse';
}

export function coverOptions(db: DbLike, periodId: Id, requestId: Id): LeaveCoverOption[] {
  return coverReports(db, periodId, requestId).map(({ assignment, report }) => ({
    assignment,
    shortfall: report.shortfall,
    candidates: report.candidates.slice(0, MAX_CANDIDATES).map((c: ReplacementCandidate) => ({
      nurseId: c.nurseId,
      label: c.label,
      payTier: c.payTier,
      overtime: c.assignment.isOvertime,
      ...(c.chargeMovedTo ? { takesChargeName: nurseName(db, c.chargeMovedTo.nurseId) } : {}),
      ...(c.replacesOnCall ? { replacesOnCall: true as const } : {}),
    })),
  }));
}

export function approveAndCover(
  db: ShiftNurseDb,
  periodId: Id,
  requestId: Id,
  reason: string | undefined,
  covers: readonly LeaveCover[],
): { request: TimeOffRequest; covered: Assignment[] } {
  if (new Set(covers.map((c) => c.assignmentId)).size !== covers.length) {
    throw new Error('Each freed shift can go to one nurse only.');
  }
  return transact(db, (tx) => {
    const pending = requestOrThrow(tx, requestId);
    const periods = touchedPeriods(tx, periodOrThrow(tx, periodId), pending);
    // Every log is opened before anything is written, anchor first: a published period without a
    // reason refuses the whole approval, not just its own shifts after the others came off. The
    // nurse asked for the leave, so a unit that requires consent for manager-initiated changes
    // does not ask for it again here.
    const logs = new Map(
      periods.map((p) => [p.id, openChangeLog(tx, p.id, reason, 'time_off')] as const),
    );
    const freedNow = periods.flatMap((p) => freedShifts(tx, p.id, pending));
    for (const cover of covers) {
      if (!freedNow.some((a) => a.id === cover.assignmentId)) throw new Error(CANNOT_COVER);
    }

    const { request, lifted } = approveTimeOffAndLiftAssignments(tx, requestId, ACTOR, reason);
    const freed = new Map(lifted.map((a) => [a.id, a]));
    // A published period's shifts are not lifted by approval; they come off here, logged.
    for (const a of freedNow) {
      if (freed.has(a.id)) continue;
      deleteAssignment(tx, a.id, ACTOR, reason);
      freed.set(a.id, a);
    }
    // Each row in its own period's log only. Approval can also lift a draft row from a period
    // the request does not overlap (the night before it); that period has no log here, and a
    // draft's log would record nothing anyway.
    for (const a of freed.values()) {
      logs.get(a.periodId)?.({ kind: 'removed', assignment: a, before: a });
    }

    // Main is the judge, not the dialog that offered the names, and it judges inside the
    // transaction that writes: against the schedule as it is now, not as the dialog saw it.
    // Periods go in start-date order so a later period's lookback tail sees an earlier period's
    // new cover.
    const covered: Assignment[] = [];
    const byStart = [...periods].sort((a, b) => compareDates(a.startDate, b.startDate));
    for (const period of byStart) {
      const mine = covers.filter((c) => freed.get(c.assignmentId)?.periodId === period.id);
      if (mine.length === 0) continue;
      const input = buildConflictInput(tx, period.id);
      // Each cover is judged with the earlier ones in place: two names that are each legal alone
      // can still give one nurse a day and a night back to back.
      let working = input.assignments;
      for (const [k, cover] of mine.entries()) {
        const gone = freed.get(cover.assignmentId)!;
        // Not `coverReports`: that judges the schedule before approval. Here the leave is applied,
        // earlier covers are in place and the freed row is already deleted, so the search starts
        // from the live state with the shift it held added back. The standby and charge-move ids
        // written below come from this search, never from what the dialog saw.
        const report = findReplacements({
          ...input,
          assignments: [...working, gone],
          absentAssignmentId: gone.id,
          lastCalledAt: {},
        });
        const candidate = report.candidates.find((c) => c.nurseId === cover.nurseId);
        if (!candidate) {
          const excluded = report.excluded.find((e) => e.nurseId === cover.nurseId);
          if (excluded) {
            const abbreviation = getShiftType(tx, gone.shiftTypeId)?.abbreviation ?? '';
            throw new Error(
              `${excluded.label} cannot cover ${describeDate(gone.date)} ${abbreviation}: ${excluded.reason}.`,
            );
          }
          throw new Error(CANNOT_COVER);
        }
        working = [...working, { id: `cover:${k}`, ...candidate.assignment }];
        const log = logs.get(period.id)!;
        // She is covering in place of her standby; leaving the row would double-book her.
        if (candidate.replacesOnCall) {
          const standby = assignmentOrThrow(tx, candidate.replacesOnCall.assignmentId);
          deleteAssignment(tx, standby.id, ACTOR, reason);
          log({ kind: 'removed', assignment: standby, before: standby });
        }
        const created = createAssignment(
          tx,
          {
            periodId: gone.periodId,
            nurseId: cover.nurseId,
            shiftTypeId: gone.shiftTypeId,
            date: gone.date,
            source: 'manual',
            // The candidate decides charge: a charge nurse's leave covered without it left the
            // shift with no charge nurse.
            isCharge: candidate.assignment.isCharge,
            isOvertime: candidate.assignment.isOvertime,
          },
          ACTOR,
          reason,
        );
        log({ kind: 'added', assignment: created, after: created });
        if (candidate.chargeMovedTo) {
          const prior = assignmentOrThrow(tx, candidate.chargeMovedTo.assignmentId);
          const updated = updateAssignment(tx, prior.id, { isCharge: true }, ACTOR, reason);
          log({ kind: 'changed', assignment: updated, before: prior, after: updated });
        }
        covered.push(created);
      }
    }
    return { request, covered };
  });
}
