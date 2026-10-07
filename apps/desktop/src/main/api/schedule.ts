/**
 * The schedule grid: live validation, and every edit — create, move, update, delete, lock —
 * through `editSchedule`, the one policy for changing a period: one transaction, refused on an
 * archived period, and on a published period a reason plus a change-log row per touched shift.
 */

import {
  type Assignment,
  addDays,
  buildRuleContext,
  datesInRange,
  defaultRuleSet,
  deriveDemand,
  evaluateSchedule,
  type Id,
  type Preference,
  preferencesBroken,
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
  floatExtras,
  getLatestRuleSet,
  getNurse,
  holidayWorkForPeriod,
  listAssignmentsForPeriod,
  listAvailabilityBlocks,
  listCredentials,
  listHolidaysForUnit,
  listIncompatibilityGroups,
  listNurseCredentialsForUnit,
  listOvertimeVolunteers,
  listPeriodsForUnit,
  listPreceptorshipsOverlapping,
  listPreferencesForUnit,
  listShiftCredentialRequirementsForUnit,
  moveAssignment,
  paidSickCallsForUnit,
  reasonWithConsent,
  recordScheduleChange,
  requireChangeConsent,
  requireChangeReason,
  requirePeriodEditable,
  restWaiversForPeriod,
  rosterForPeriod,
  type ShiftNurseDb,
  type ShiftNurseTx,
  saveRuleSet,
  setLocked as setAssignmentLocked,
  setRequestsCloseOn,
  timeOffForPeriod,
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
  const unit = unitOrThrow(db, period.unitId);
  const floats = floatExtras(db, unit, period, nurses);
  const ctx = buildRuleContext({
    unit,
    demand: deriveDemand(
      datesInRange(period.startDate, period.endDate),
      demandInputs(db, period.unitId, period.startDate, period.endDate),
    ),
    nurses,
    shiftTypes,
    // Nurses floated in from other units bring their own leave and credentials; the unit-scoped
    // lists miss them, as loadPeriodInput's do (it reads the same `floatExtras`).
    timeOff: [...timeOffForPeriod(db, unit, period), ...floats.timeOff],
    credentials: listCredentials(db),
    nurseCredentials: [
      ...listNurseCredentialsForUnit(db, period.unitId),
      ...floats.nurseCredentials,
    ],
    shiftCredentialRequirements: listShiftCredentialRequirementsForUnit(db, period.unitId),
    holidays: listHolidaysForUnit(db, period.unitId),
    weekendDefinition: ruleSet.weekendDefinition,
    paidSickCalls: paidSickCallsForUnit(db, period.unitId, {
      start: addDays(period.startDate, -14),
      end: period.endDate,
    }),
    incompatibilityGroups: listIncompatibilityGroups(db, period.unitId),
    overtimeVolunteers: listOvertimeVolunteers(db, period.unitId),
    // The same window loadPeriodInput reads, lookback included.
    preceptorships: listPreceptorshipsOverlapping(
      db,
      period.unitId,
      addDays(period.startDate, -14),
      period.endDate,
    ),
    restWaivers: restWaiversForPeriod(db, period.unitId, period.startDate, period.endDate),
    availabilityBlocks: listAvailabilityBlocks(db, period.unitId),
    holidayWork: holidayWorkForPeriod(db, period),
  });
  // Which preferences each worked shift goes against, so the grid can say "avoids nights"
  // rather than leave a broken request invisible until the nurse complains.
  const preferences = [...listPreferencesForUnit(db, period.unitId), ...floats.preferences];
  const byNurse = new Map<Id, Preference[]>();
  for (const p of preferences) byNurse.set(p.nurseId, [...(byNurse.get(p.nurseId) ?? []), p]);
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
  consent?: string,
): T {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    const required = requireChangeReason(period, reason);
    const agreed = requireChangeConsent(period, unitOrThrow(tx, period.unitId), source, consent);
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
          ...(agreed ? { consent: agreed } : {}),
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

export function scheduleApi(db: ShiftNurseDb): ShiftNurseApi['schedule'] {
  return {
    validate: (periodId) => buildScheduleValidation(db, periodId),
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
