/**
 * The schedule grid: live validation, and every edit — create, move, update, delete, lock —
 * through `editSchedule`, the one policy for changing a period: one transaction, refused on an
 * archived period, and on a published period a reason plus a change-log row per touched shift.
 */

import {
  type Assignment,
  buildRuleContext,
  datesInRange,
  defaultRuleSet,
  deriveDemand,
  evaluateSchedule,
  type Id,
  type RuleSet,
  type ScheduleChangeKind,
  type ScheduleChangeSource,
  type SchedulePeriod,
  type ScheduleView,
} from '@shiftnurse/core';
import {
  createAssignment,
  createPeriod,
  type DbLike,
  deleteAssignment,
  demandInputs,
  getLatestRuleSet,
  listAssignmentsForPeriod,
  listCredentials,
  listHolidaysForUnit,
  listNurseCredentialsForUnit,
  listPeriodsForUnit,
  listShiftCredentialRequirementsForUnit,
  listTimeOffForUnit,
  moveAssignment,
  recordScheduleChange,
  requireChangeReason,
  requirePeriodEditable,
  type ShiftNurseDb,
  type ShiftNurseTx,
  saveRuleSet,
  setLocked as setAssignmentLocked,
  transact,
  updateAssignment as updateAssignmentDb,
} from '@shiftnurse/db';
import type { ScheduleValidation, ShiftNurseApi } from '../../shared/api.js';

import {
  ACTOR,
  assignmentOrThrow,
  periodOrThrow,
  ruleSetFor,
  scheduleViewFor,
  unitOrThrow,
} from './context.js';

/** The full context the rule engine needs to score one period, over a view the caller built. */
export function validateView(
  db: DbLike,
  period: SchedulePeriod,
  ruleSet: RuleSet,
  schedule: ScheduleView,
): ScheduleValidation {
  const nurses = [...schedule.nursesById.values()];
  const shiftTypes = [...schedule.shiftTypesById.values()];
  const ctx = buildRuleContext({
    unit: unitOrThrow(db, period.unitId),
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ),
    nurses,
    shiftTypes,
    timeOff: listTimeOffForUnit(db, period.unitId),
    credentials: listCredentials(db),
    nurseCredentials: listNurseCredentialsForUnit(db, period.unitId),
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, period.unitId),
    holidays: listHolidaysForUnit(db, period.unitId),
    weekendDefinition: ruleSet.weekendDefinition,
  });
  return { ruleSet, result: evaluateSchedule(schedule, ruleSet, ctx) };
}

export function buildScheduleValidation(db: DbLike, periodId: Id): ScheduleValidation {
  const period = periodOrThrow(db, periodId);
  const ruleSet = ruleSetFor(db, period);
  return validateView(db, period, ruleSet, scheduleViewFor(db, period, { lookback: true }));
}

export interface ChangeLogEntry {
  kind: ScheduleChangeKind;
  assignment: Assignment;
  before?: Assignment;
  after?: Assignment;
}

/**
 * Run a grid edit inside one transaction and, when the period is published, write each
 * touched shift to the change log under the manager's reason. On a draft `log` is a no-op
 * and the reason is dropped; on an archived period the edit is refused before it starts.
 */
export function editSchedule<T>(
  db: ShiftNurseDb,
  periodId: Id,
  reason: string | undefined,
  source: ScheduleChangeSource,
  work: (tx: ShiftNurseTx, log: (entry: ChangeLogEntry) => void) => T,
): T {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    const required = requireChangeReason(period, reason);
    const log = (entry: ChangeLogEntry) => {
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
        },
        ACTOR,
      );
    };
    return work(tx, log);
  });
}

export function periodsApi(db: ShiftNurseDb): ShiftNurseApi['periods'] {
  return {
    list: (unitId) => listPeriodsForUnit(db, unitId),
    assignments: (periodId) => listAssignmentsForPeriod(db, periodId),
    create: ({ unitId, name, startDate, endDate }) => {
      const ruleSet =
        getLatestRuleSet(db, unitId) ?? saveRuleSet(db, defaultRuleSet(unitId), ACTOR);
      return createPeriod(
        db,
        {
          unitId,
          name,
          startDate,
          endDate,
          ruleSetId: ruleSet.id,
          ruleSetVersion: ruleSet.version,
        },
        ACTOR,
      );
    },
  };
}

export function scheduleApi(db: ShiftNurseDb): ShiftNurseApi['schedule'] {
  return {
    validate: (periodId) => buildScheduleValidation(db, periodId),
    createAssignment: (input, reason) =>
      editSchedule(db, input.periodId, reason, 'manual', (tx, log) => {
        // Picked field by field: IPC payloads are typed, not checked, and `source` is never an
        // input — a hand-placed shift is 'manual' whatever the renderer sent.
        const { periodId, nurseId, shiftTypeId, date, isLocked, isCharge, isOvertime, notes } =
          input;
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
          reason,
        );
        log({ kind: 'added', assignment: created, after: created });
        return created;
      }),
    moveAssignment: ({ assignmentId, nurseId, shiftTypeId, date }, reason) => {
      const existing = assignmentOrThrow(db, assignmentId);
      return editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
        const moved = moveAssignment(
          tx,
          assignmentId,
          { nurseId, shiftTypeId, date },
          ACTOR,
          'manual',
          reason,
        );
        log({ kind: 'removed', assignment: existing, before: existing });
        log({ kind: 'added', assignment: moved, after: moved });
        return moved;
      });
    },
    updateAssignment: (assignmentId, patch, reason) => {
      const existing = assignmentOrThrow(db, assignmentId);
      return editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
        const updated = updateAssignmentDb(tx, assignmentId, patch, ACTOR, reason);
        log({ kind: 'changed', assignment: existing, before: existing, after: updated });
        return updated;
      });
    },
    deleteAssignment: (assignmentId, reason) => {
      const existing = assignmentOrThrow(db, assignmentId);
      editSchedule(db, existing.periodId, reason, 'manual', (tx, log) => {
        deleteAssignment(tx, assignmentId, ACTOR, reason);
        log({ kind: 'removed', assignment: existing, before: existing });
      });
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
