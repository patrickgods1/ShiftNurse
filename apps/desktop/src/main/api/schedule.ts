/**
 * The schedule grid: live validation, and every edit — create, move, update, delete, lock —
 * through `editSchedule`, the one policy for changing a period: one transaction, refused on an
 * archived period, and on a published period a reason plus a change-log row per touched shift.
 */

import {
  type Assignment,
  compareDates,
  contractedHoursRule,
  defaultRuleSet,
  evaluateSchedule,
  type Id,
  type IsoDate,
  type Preference,
  payPeriodHoursFor,
  payPeriodIndex,
  payPeriodWindow,
  preferencesBroken,
  requireParams,
  resolveConfigs,
  ruleContextForInput,
  type ScheduleChangeKind,
  type ScheduleChangeSource,
  type SchedulePeriod,
  type ScheduleView,
  type SolveInput,
} from '@shiftnurse/core';
import {
  createAssignment,
  createPeriod,
  type DbLike,
  deleteAssignment,
  getLatestRuleSet,
  getNurse,
  historyFromFor,
  listAssignmentsForPeriod,
  listPeriodsForUnit,
  loadPeriodInput,
  moveAssignment,
  reasonWithConsent,
  recordScheduleChange,
  requireChangeConsent,
  requireChangeReason,
  requirePeriodEditable,
  rosterForPeriod,
  type ShiftNurseDb,
  type ShiftNurseTx,
  saveRuleSet,
  setLocked as setAssignmentLocked,
  setRequestsCloseOn,
  transact,
  updateAssignment as updateAssignmentDb,
} from '@shiftnurse/db';
import type { NurseHoursReadout, ScheduleValidation, ShiftNurseApi } from '../../shared/api.js';

import {
  ACTOR,
  assignmentOrThrow,
  periodOrThrow,
  scheduleViewFor,
  unitOrThrow,
} from './context.js';

/**
 * The grid's verdict on a view the caller built (the period's own rows, or a Generate candidate).
 * It is judged from `loadPeriodInput`, the same input Generate and conflicts read, through the
 * same mapping (`ruleContextForInput`), and by the period's own rule-set snapshot: a context
 * assembled here by hand once missed floats' leave and credentials, and any input added to
 * `loadPeriodInput` only would have been honoured by Generate and silently ignored on screen.
 * Callers that already loaded the input pass it, so one call reads the tables once.
 */
export function validateView(
  db: DbLike,
  period: SchedulePeriod,
  schedule: ScheduleView,
  input: SolveInput = loadPeriodInput(db, period),
): ScheduleValidation {
  const { ruleSet } = input;
  const ctx = ruleContextForInput(input);
  // Which preferences each worked shift goes against, so the grid can say "avoids nights"
  // rather than leave a broken request invisible until the nurse complains. Floats' preferences
  // ride in the input's list.
  const byNurse = new Map<Id, Preference[]>();
  for (const p of input.preferences) {
    byNurse.set(p.nurseId, [...(byNurse.get(p.nurseId) ?? []), p]);
  }
  const againstPreference: Record<Id, Preference[]> = {};
  for (const view of schedule.assignments()) {
    if (view.shiftType.isOnCall) continue;
    const broken = preferencesBroken(
      view,
      byNurse.get(view.nurse.id) ?? [],
      ruleSet.weekendDefinition,
    );
    if (broken.length > 0) againstPreference[view.assignment.id] = broken;
  }
  return { ruleSet, result: evaluateSchedule(schedule, ruleSet, ctx), againstPreference };
}

export function buildScheduleValidation(db: DbLike, periodId: Id): ScheduleValidation {
  const period = periodOrThrow(db, periodId);
  return validateView(db, period, scheduleViewFor(db, period, { lookback: true, floated: 'busy' }));
}

/**
 * A nurse's hours in the pay period holding `date`, from core's `payPeriodHoursFor` over the very
 * view and rule context the grid is judged by (`buildScheduleValidation`'s view, `loadPeriodInput`
 * through `ruleContextForInput`). The popover used to add up the visible period in the renderer,
 * which missed the published week before and paid leave and so disagreed with the rule.
 */
export function nurseHoursReadout(
  db: DbLike,
  periodId: Id,
  nurseId: Id,
  date: IsoDate,
): NurseHoursReadout {
  const period = periodOrThrow(db, periodId);
  const input = loadPeriodInput(db, period);
  const schedule = scheduleViewFor(db, period, { lookback: true, floated: 'busy' });
  const nurse = schedule.nursesById.get(nurseId);
  if (!nurse) throw new Error(`That nurse is not on ${period.name}'s roster.`);
  const params = requireParams(contractedHoursRule, resolveConfigs(input.ruleSet));
  const payPeriod = payPeriodWindow(payPeriodIndex(date, input.unit), input.unit);
  const hours = payPeriodHoursFor(schedule, nurseId, payPeriod, params, ruleContextForInput(input));
  // The view holds this period plus the published tail: days after the period end are on no
  // loaded schedule, and days before `historyFrom` are on no published one.
  const historyFrom = historyFromFor(db, period);
  const complete =
    (compareDates(payPeriod.start, period.startDate) >= 0 ||
      compareDates(historyFrom, payPeriod.start) <= 0) &&
    compareDates(payPeriod.end, period.endDate) <= 0;
  return {
    payPeriod,
    scheduledHours: hours.scheduledHours,
    priorHours: hours.priorHours,
    paidLeaveHours: hours.paidLeaveHours,
    contractedHours: nurse.contractedHoursPerPeriod,
    complete,
  };
}

export interface ChangeLogEntry {
  kind: ScheduleChangeKind;
  assignment: Assignment;
  before?: Assignment;
  after?: Assignment;
}

/**
 * Run a grid edit inside one transaction and, when the period is published, write each
 * touched shift to the change log under the manager's reason. On a draft the change log is
 * skipped; the reason, if given, is still kept on the shift's audit row. On an archived period
 * the edit is refused before it starts.
 */
export function editSchedule<T>(
  db: ShiftNurseDb,
  periodId: Id,
  reason: string | undefined,
  source: ScheduleChangeSource,
  work: (tx: ShiftNurseTx, log: (entry: ChangeLogEntry) => void) => T,
  consent?: string,
): T {
  return transact(db, (tx) => work(tx, openChangeLog(tx, periodId, reason, source, consent)));
}

/**
 * The inside of `editSchedule`, for a handler that must word its reason from something it reads
 * in the transaction (the place a nurse holds in an order). Refuses exactly as `editSchedule`
 * does; call it first in the transaction.
 */
export function openChangeLog(
  tx: ShiftNurseTx,
  periodId: Id,
  reason: string | undefined,
  source: ScheduleChangeSource,
  consent?: string,
): (entry: ChangeLogEntry) => void {
  const period = periodOrThrow(tx, periodId);
  const required = requireChangeReason(period, reason);
  const agreed = requireChangeConsent(period, unitOrThrow(tx, period.unitId), source, consent);
  return (entry) => {
    if (required === undefined) return;
    const a = entry.assignment;
    recordScheduleChange(
      tx,
      {
        periodId,
        kind: entry.kind,
        source,
        assignmentId: a.id,
        nurseId: a.nurseId,
        date: a.date,
        shiftTypeId: a.shiftTypeId,
        before: entry.before,
        after: entry.after,
        reason: required,
        ...(agreed ? { consent: agreed } : {}),
      },
      ACTOR,
    );
  };
}

export function periodsApi(db: ShiftNurseDb): ShiftNurseApi['periods'] {
  return {
    list: (unitId) => listPeriodsForUnit(db, unitId),
    assignments: (periodId) => listAssignmentsForPeriod(db, periodId),
    create: ({ unitId, name, startDate, endDate, requestsCloseOn }) =>
      transact(db, (tx) => {
        const ruleSet =
          getLatestRuleSet(tx, unitId) ?? saveRuleSet(tx, defaultRuleSet(unitId), ACTOR);
        return createPeriod(
          tx,
          {
            unitId,
            name,
            startDate,
            endDate,
            ruleSetId: ruleSet.id,
            ruleSetVersion: ruleSet.version,
            ...(requestsCloseOn ? { requestsCloseOn } : {}),
          },
          ACTOR,
        );
      }),
    setRequestsCloseOn: (periodId, date) =>
      transact(db, (tx) => setRequestsCloseOn(tx, periodId, date ?? undefined, ACTOR)),
  };
}

/**
 * Refuse a shift for a nurse the period's roster does not hold — a float whose membership does
 * not reach these dates. Validation and Generate judge that roster, so such a shift could not be
 * judged at all; the refusal says what to do instead.
 */
export function requireOnRoster(db: DbLike, periodId: Id, nurseId: Id): void {
  const period = periodOrThrow(db, periodId);
  if (rosterForPeriod(db, period).some((n) => n.id === nurseId)) return;
  const nurse = getNurse(db, nurseId);
  const who = nurse ? `${nurse.firstName} ${nurse.lastName}` : 'That nurse';
  throw new Error(
    `${who} is not on this unit's roster for ${period.name}. Add a float membership covering ` +
      'these dates under Roster first.',
  );
}

/**
 * Refuse a new shift for a nurse who has left. The solver already skips inactive nurses, but a
 * hand edit could still give one a shift the grid hides her row for. Giving her shifts away stays
 * allowed: covering them is the point. Unknown ids are left to the roster check.
 */
export function requireActiveRecipient(db: DbLike, nurseId: Id): void {
  const nurse = getNurse(db, nurseId);
  if (nurse?.active !== false) return;
  throw new Error(
    `${nurse.firstName} ${nurse.lastName} is inactive, so they cannot take new shifts. ` +
      'Reactivate them on the Roster first.',
  );
}

export function scheduleApi(db: ShiftNurseDb): ShiftNurseApi['schedule'] {
  return {
    validate: (periodId) => buildScheduleValidation(db, periodId),
    nurseHours: (periodId, nurseId, date) => nurseHoursReadout(db, periodId, nurseId, date),
    createAssignment: (input, reason, consent) =>
      editSchedule(
        db,
        input.periodId,
        reason,
        'manual',
        (tx, log) => {
          // Picked field by field: IPC payloads are typed, not checked, and `source` is never an
          // input — a hand-placed shift is 'manual' whatever the renderer sent.
          const { periodId, nurseId, shiftTypeId, date, isLocked, isCharge, isOvertime, notes } =
            input;
          requireOnRoster(tx, periodId, nurseId);
          requireActiveRecipient(tx, nurseId);
          const created = createAssignment(
            tx,
            {
              periodId,
              nurseId,
              shiftTypeId,
              date,
              source: 'manual',
              isLocked,
              isCharge,
              isOvertime,
              notes,
            },
            ACTOR,
            reasonWithConsent(reason, consent),
          );
          log({ kind: 'added', assignment: created, after: created });
          return created;
        },
        consent,
      ),
    moveAssignment: ({ assignmentId, nurseId, shiftTypeId, date }, reason, consent) => {
      const existing = assignmentOrThrow(db, assignmentId);
      return editSchedule(
        db,
        existing.periodId,
        reason,
        'manual',
        (tx, log) => {
          requireOnRoster(tx, existing.periodId, nurseId);
          requireActiveRecipient(tx, nurseId);
          const moved = moveAssignment(
            tx,
            assignmentId,
            { nurseId, shiftTypeId, date },
            ACTOR,
            'manual',
            reasonWithConsent(reason, consent),
          );
          log({ kind: 'removed', assignment: existing, before: existing });
          log({ kind: 'added', assignment: moved, after: moved });
          return moved;
        },
        consent,
      );
    },
    // Two nurses trade shifts: both moves in one transaction, so a refusal of either (a locked
    // row, a nurse already on that shift) leaves both where they were. A half-done swap would
    // put one nurse on two shifts and leave the other off the schedule.
    swapAssignments: (firstId, secondId, reason, consent) => {
      const first = assignmentOrThrow(db, firstId);
      const second = assignmentOrThrow(db, secondId);
      if (first.periodId !== second.periodId) {
        throw new Error('Only shifts on the same schedule can be swapped');
      }
      if (first.nurseId === second.nurseId) {
        throw new Error('Both shifts belong to the same nurse; there is nothing to swap');
      }
      return editSchedule(
        db,
        first.periodId,
        reason,
        'manual',
        (tx, log) => {
          // Each nurse receives the other's shift.
          requireActiveRecipient(tx, first.nurseId);
          requireActiveRecipient(tx, second.nurseId);
          for (const a of [first, second]) {
            if (a.isLocked) throw new Error('One of those shifts is locked; unlock it to swap it');
          }
          const toSecond = moveAssignment(
            tx,
            first.id,
            { nurseId: second.nurseId, shiftTypeId: first.shiftTypeId, date: first.date },
            ACTOR,
            'manual',
            reasonWithConsent(reason, consent),
          );
          const toFirst = moveAssignment(
            tx,
            second.id,
            { nurseId: first.nurseId, shiftTypeId: second.shiftTypeId, date: second.date },
            ACTOR,
            'manual',
            reasonWithConsent(reason, consent),
          );
          log({ kind: 'removed', assignment: first, before: first });
          log({ kind: 'removed', assignment: second, before: second });
          log({ kind: 'added', assignment: toSecond, after: toSecond });
          log({ kind: 'added', assignment: toFirst, after: toFirst });
          return [toFirst, toSecond] as [Assignment, Assignment];
        },
        consent,
      );
    },
    updateAssignment: (assignmentId, patch, reason, consent) => {
      const existing = assignmentOrThrow(db, assignmentId);
      return editSchedule(
        db,
        existing.periodId,
        reason,
        'manual',
        (tx, log) => {
          const updated = updateAssignmentDb(
            tx,
            assignmentId,
            patch,
            ACTOR,
            reasonWithConsent(reason, consent),
          );
          log({ kind: 'changed', assignment: existing, before: existing, after: updated });
          return updated;
        },
        consent,
      );
    },
    deleteAssignment: (assignmentId, reason, consent) => {
      const existing = assignmentOrThrow(db, assignmentId);
      editSchedule(
        db,
        existing.periodId,
        reason,
        'manual',
        (tx, log) => {
          deleteAssignment(tx, assignmentId, ACTOR, reasonWithConsent(reason, consent));
          log({ kind: 'removed', assignment: existing, before: existing });
        },
        consent,
      );
    },
    // A lock is deliberately not in the change log (it pins a shift for Generate; it does
    // not change who works), so it skips `editSchedule` — but not the archived check.
    setLocked: (assignmentId, locked) =>
      transact(db, (tx) => {
        const existing = assignmentOrThrow(tx, assignmentId);
        requirePeriodEditable(periodOrThrow(tx, existing.periodId));
        return setAssignmentLocked(tx, assignmentId, locked, ACTOR);
      }),
  };
}
