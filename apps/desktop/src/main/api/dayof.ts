/**
 * The Today screen: who is on now, the live staffing check, and the call-off workflow — report,
 * ranked replacements, call log, and the backfill that writes the replacement's shift through
 * the published-schedule change log.
 */

import {
  addDays,
  type CallOff,
  type CallOutcome,
  checkStaffing,
  describeDate,
  findReplacements,
  type Id,
  type IsoDate,
  isFloatedOff,
  type Nurse,
  type ReplacementReport,
  type ShiftType,
  shiftsAround,
  today,
} from '@shiftnurse/core';
import {
  cancelCallOff,
  createAssignment,
  type DbLike,
  deleteAssignment,
  demandInputs,
  getAssignment,
  getCallOff,
  getCancellationPolicy,
  getNurse,
  getShiftType,
  holdoverRefusal,
  lastCalledAt,
  lastOvertimeDates,
  listAssignmentsForPeriodOnDate,
  listCallAttempts,
  listCallOffsForUnit,
  listCensusForecastsInRange,
  listShiftTypesForUnit,
  logCallAttempt,
  markCallOffCovered,
  markCallOffUncovered,
  openCallOffForAssignment,
  recordHoldover,
  reportCallOff,
  rosterForPeriod,
  type ShiftNurseDb,
  type ShiftNurseTx,
  saveCancellationPolicy,
  transact,
} from '@shiftnurse/db';
import type {
  BackfillResult,
  CallOffView,
  DayOfSummary,
  RosterEntryView,
  ShiftNurseApi,
  TodayShiftView,
} from '../../shared/api.js';

import { cancelForCensus, cancellationOrderFor, overstaffedRoles } from './census-cancellation.js';
import { hostMinuteOfDay } from './clock.js';
import {
  ACTOR,
  assignmentOrThrow,
  buildConflictInput,
  periodCoveringDate,
  periodOrThrow,
} from './context.js';
import { editSchedule } from './schedule.js';

/** How far back the call log is read when spreading calls across the pool. */
const LAST_CALL_LOOKBACK_DAYS = 180;

function getCallOffOrThrow(db: DbLike, id: Id): CallOff {
  const callOff = getCallOff(db, id);
  if (!callOff) throw new Error('That call-off was not found; it may have been cancelled.');
  return callOff;
}

function callOffView(db: DbLike, callOff: CallOff): CallOffView {
  const nurse = getNurse(db, callOff.nurseId);
  if (!nurse) throw new Error('That nurse was not found. Reload the page.');
  const shiftType = getShiftType(db, callOff.shiftTypeId);
  if (!shiftType) throw new Error('That shift type was not found. Reload the page.');
  const period = periodOrThrow(db, callOff.periodId);
  const assignment = getAssignment(db, callOff.assignmentId);
  const attempts = listCallAttempts(db, callOff.id);

  let replacement: CallOffView['replacement'];
  if (callOff.replacementAssignmentId !== undefined) {
    const row = getAssignment(db, callOff.replacementAssignmentId);
    const repNurse = row ? getNurse(db, row.nurseId) : undefined;
    if (row && repNurse) replacement = { assignment: row, nurse: repNurse };
  }

  return {
    callOff,
    ...(assignment ? { assignment } : {}),
    nurse,
    shiftType,
    period,
    attempts,
    ...(replacement ? { replacement } : {}),
  };
}

/** One (date, shiftType) slot the Today screen shows, with its current/next/other precedence. */
interface StatusSlot {
  date: IsoDate;
  shiftTypeId: Id;
  status: 'current' | 'next' | 'other';
}

/**
 * Current slots first, then the next slot, then every active type on `date` in sort order —
 * deduped on `(date, shiftTypeId)` so a shift that is both "current" (spanning midnight) and
 * "on today's list" appears once, tagged with its highest-precedence status.
 */
function collectSlots(
  shiftTypes: readonly ShiftType[],
  date: IsoDate,
  around: ReturnType<typeof shiftsAround>,
): StatusSlot[] {
  const byKey = new Map<string, StatusSlot>();
  const upsert = (slotDate: IsoDate, shiftTypeId: Id, status: StatusSlot['status']) => {
    const key = `${slotDate}::${shiftTypeId}`;
    if (!byKey.has(key)) byKey.set(key, { date: slotDate, shiftTypeId, status });
  };
  for (const s of around.current) upsert(s.date, s.shiftTypeId, 'current');
  if (around.next) upsert(around.next.date, around.next.shiftTypeId, 'next');
  for (const t of [...shiftTypes]
    .filter((t) => t.active)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    upsert(date, t.id, 'other');
  }
  return [...byKey.values()];
}

/** Everything one date needs for its staffing check: the covering period's own assignments. */
function planForDate(
  db: DbLike,
  unitId: Id,
  shiftTypes: readonly ShiftType[],
  nurses: readonly Nurse[],
  date: IsoDate,
) {
  const period = periodCoveringDate(db, unitId, date);
  const assignments = period ? listAssignmentsForPeriodOnDate(db, period.id, date) : [];
  const checks = checkStaffing({
    date,
    shiftTypes,
    nurses,
    assignments,
    demand: demandInputs(db, unitId, date, date),
  });
  const census = listCensusForecastsInRange(db, unitId, date, date);
  return { period, assignments, checks, census };
}

function dayOfSummary(db: DbLike, unitId: Id, date?: IsoDate): DayOfSummary {
  const d = date ?? today();
  const minuteOfDay = hostMinuteOfDay();
  const shiftTypes = listShiftTypesForUnit(db, unitId);
  const shiftTypeById = new Map(shiftTypes.map((t) => [t.id, t]));

  // The host clock says where "now" is only on today's date; another day has no running shift,
  // so every slot is `other` rather than tagging tomorrow's Day shift current at 15:00.
  const around =
    d === today() ? shiftsAround(shiftTypes, d, minuteOfDay) : { current: [], next: undefined };
  const slots = collectSlots(shiftTypes, d, around);

  // Spans every slot's date: late in the evening `next` is tomorrow's shift, and a float whose
  // membership starts tomorrow is not on a roster that ends today.
  const dates = [...new Set(slots.map((s) => s.date))].sort();
  const nurses = rosterForPeriod(db, { unitId, startDate: dates[0]!, endDate: dates.at(-1)! });
  const nurseById = new Map(nurses.map((n) => [n.id, n]));

  // Loaded once: every open call-off on the unit, whatever its date, so a roster row can show
  // the call-off against it without a query per assignment.
  const openCallOffRows = listCallOffsForUnit(db, unitId, { status: 'open' });
  const callOffByAssignment = new Map(openCallOffRows.map((c) => [c.assignmentId, c]));

  const perDate = new Map<IsoDate, ReturnType<typeof planForDate>>();
  for (const slotDate of dates) {
    perDate.set(slotDate, planForDate(db, unitId, shiftTypes, nurses, slotDate));
  }

  const shifts: TodayShiftView[] = slots.map((slot) => {
    const plan = perDate.get(slot.date);
    if (!plan) throw new Error(`No staffing plan computed for ${slot.date}`);
    const shiftType = shiftTypeById.get(slot.shiftTypeId);
    if (!shiftType) throw new Error('That shift type was not found. Reload the page.');
    const staffing = plan.checks.find((c) => c.shiftTypeId === slot.shiftTypeId);
    if (!staffing)
      throw new Error(
        `Today could not check staffing for ${describeDate(slot.date)} ${shiftType.abbreviation}.`,
      );
    const census = plan.census.find(
      (c) => c.shiftTypeId === slot.shiftTypeId && c.date === slot.date,
    );
    const roster: RosterEntryView[] = plan.assignments
      // A floated-off shift stays on the schedule for her hours but she is not on this unit's
      // floor, so no call-off or backfill is offered for her.
      .filter((a) => a.shiftTypeId === slot.shiftTypeId && a.date === slot.date && !isFloatedOff(a))
      .map((a) => {
        const nurse = nurseById.get(a.nurseId);
        if (!nurse)
          throw new Error(
            `${describeDate(a.date)}: a shift is held by a nurse who is not on this unit's roster for that day. Check their float membership under Roster.`,
          );
        const callOff = callOffByAssignment.get(a.id);
        return { assignment: a, nurse, ...(callOff ? { callOff } : {}) };
      })
      .sort(
        (x, y) =>
          x.nurse.lastName.localeCompare(y.nurse.lastName) ||
          x.nurse.firstName.localeCompare(y.nurse.firstName),
      );
    return {
      date: slot.date,
      shiftType,
      ...(census ? { census } : {}),
      staffing,
      overstaffed: plan.period ? overstaffedRoles(plan.period.id, staffing) : [],
      roster,
      status: slot.status,
    };
  });

  return {
    date: d,
    minuteOfDay,
    period: periodCoveringDate(db, unitId, d),
    shifts,
    openCallOffs: openCallOffRows.map((c) => callOffView(db, c)),
  };
}

/** The shift a call-off or backfill acts on; a floated-off row is not this unit's to call off. */
function onUnitShiftOrThrow(db: DbLike, assignmentId: Id) {
  const row = assignmentOrThrow(db, assignmentId);
  if (isFloatedOff(row)) {
    const nurse = getNurse(db, row.nurseId);
    throw new Error(
      `${nurse ? `${nurse.firstName} ${nurse.lastName}` : 'That nurse'} was floated to ${row.floatedTo} for this shift; she is not on this unit's shift.`,
    );
  }
  return row;
}

function reportDayOfCallOff(
  db: ShiftNurseTx,
  assignmentId: Id,
  reason?: string,
  paidSickHours?: number,
): CallOff {
  if (openCallOffForAssignment(db, assignmentId)) {
    throw new Error('A call-off is already open for this assignment');
  }
  const absent = onUnitShiftOrThrow(db, assignmentId);
  const period = periodOrThrow(db, absent.periodId);
  if (period.status === 'archived') {
    throw new Error(`Period "${period.name}" is archived; cannot report a call-off against it`);
  }
  return reportCallOff(
    db,
    assignmentId,
    ACTOR,
    reason,
    paidSickHours === undefined ? {} : { paidSickHours },
  );
}

/** Ranked, eligible-only replacements, simulated on the period's own rule-set snapshot. */
function replacementsFor(db: DbLike, callOffId: Id): ReplacementReport {
  const callOff = getCallOffOrThrow(db, callOffId);
  if (callOff.status !== 'open') {
    throw new Error(`This call-off is ${callOff.status}, not open.`);
  }
  const period = periodOrThrow(db, callOff.periodId);
  const lastCalled = Object.fromEntries(
    lastCalledAt(db, period.unitId, addDays(today(), -LAST_CALL_LOOKBACK_DAYS)),
  );
  return findReplacements({
    ...buildConflictInput(db, callOff.periodId),
    absentAssignmentId: callOff.assignmentId,
    lastCalledAt: lastCalled,
    lastOvertimeOn: Object.fromEntries(lastOvertimeDates(db, period.unitId, callOff.date)),
  });
}

function logCall(
  db: ShiftNurseTx,
  callOffId: Id,
  nurseId: Id,
  outcome: Exclude<CallOutcome, 'accepted'>,
  notes?: string,
) {
  // Defence in depth: the type excludes `'accepted'`, but IPC input is not type-checked at
  // runtime, and an accepted call must never bypass the row it also has to write.
  if ((outcome as CallOutcome) === 'accepted') {
    throw new Error('An accepted call is recorded through backfill, which also writes the shift');
  }
  return logCallAttempt(db, callOffId, nurseId, outcome, ACTOR, notes);
}

/**
 * The nurse said yes. Re-runs `findReplacements` immediately before writing — never trusting a
 * renderer-sent verdict, exactly as `exchange.approve` re-evaluates before applying — then
 * replaces the absent assignment with the candidate's row in one transaction, through the
 * published-schedule change log as `source: 'backfill'`.
 */
function backfill(db: ShiftNurseDb, callOffId: Id, nurseId: Id, notes?: string): BackfillResult {
  const callOff = getCallOffOrThrow(db, callOffId);
  if (callOff.status !== 'open') {
    throw new Error(`This call-off is ${callOff.status}, not open.`);
  }
  if (!getNurse(db, nurseId)) throw new Error('That nurse was not found. Reload the page.');
  // The reason names who was ABSENT — that is the fact being explained. The replacement's
  // name is already on the `added` row the change log writes below.
  const absentNurse = getNurse(db, callOff.nurseId);
  if (!absentNurse) throw new Error('That nurse was not found. Reload the page.');
  const shiftType = getShiftType(db, callOff.shiftTypeId);
  if (!shiftType) throw new Error('That shift type was not found. Reload the page.');
  const reason =
    `Call-off: ${absentNurse.firstName} ${absentNurse.lastName}, ${callOff.date} ${shiftType.abbreviation}` +
    (callOff.reason ? ` — ${callOff.reason}` : '');

  return editSchedule(db, callOff.periodId, reason, 'backfill', (tx, log) => {
    const absent = onUnitShiftOrThrow(tx, callOff.assignmentId);
    // The cover is a new row; the absent nurse's recorded holdover cannot move to it.
    if ((absent.holdoverMinutes ?? 0) > 0) throw new Error(holdoverRefusal(absent));
    const report = findReplacements({
      ...buildConflictInput(tx, callOff.periodId),
      absentAssignmentId: absent.id,
      // Only whether the nurse is still a candidate matters here, not where they rank: the
      // manager already phoned down the list. So the ranking inputs (call history, last
      // overtime) are not reloaded.
      lastCalledAt: {},
    });
    const candidate = report.candidates.find((c) => c.nurseId === nurseId);
    if (!candidate) {
      const excluded = report.excluded.find((e) => e.nurseId === nurseId);
      throw new Error(
        excluded
          ? `${excluded.label} is not eligible for this shift: ${excluded.reason}`
          : 'That nurse is not eligible for this shift.',
      );
    }
    deleteAssignment(tx, absent.id, ACTOR, reason);
    log({ kind: 'removed', assignment: absent, before: absent });
    const created = createAssignment(
      tx,
      { ...candidate.assignment, ...(notes ? { notes } : {}) },
      ACTOR,
      reason,
    );
    log({ kind: 'added', assignment: created, after: created });
    const attempt = logCallAttempt(tx, callOff.id, nurseId, 'accepted', ACTOR, notes);
    const covered = markCallOffCovered(tx, callOff.id, created.id, ACTOR);
    return { callOff: covered, attempt, assignment: created };
  });
}

export function dayOfApi(db: ShiftNurseDb): ShiftNurseApi['dayOf'] {
  return {
    today: (unitId, date) => dayOfSummary(db, unitId, date),
    callOffs: (unitId, start, end) =>
      listCallOffsForUnit(db, unitId, { start, end }).map((c) => callOffView(db, c)),
    reportCallOff: (assignmentId, reason, paidSickHours) =>
      transact(db, (tx) => reportDayOfCallOff(tx, assignmentId, reason, paidSickHours)),
    replacements: (callOffId) => replacementsFor(db, callOffId),
    logCall: (callOffId, nurseId, outcome, notes) =>
      transact(db, (tx) => logCall(tx, callOffId, nurseId, outcome, notes)),
    backfill: (callOffId, nurseId, notes) => backfill(db, callOffId, nurseId, notes),
    markUncovered: (callOffId, reason) =>
      transact(db, (tx) => markCallOffUncovered(tx, callOffId, ACTOR, reason)),
    cancelCallOff: (callOffId, reason) =>
      transact(db, (tx) => cancelCallOff(tx, callOffId, ACTOR, reason)),
    callLog: (callOffId) => listCallAttempts(db, callOffId),
    cancellationPolicy: (unitId) => getCancellationPolicy(db, unitId),
    saveCancellationPolicy: (unitId, tiers) =>
      transact(db, (tx) => saveCancellationPolicy(tx, unitId, tiers, ACTOR)),
    cancellationOrder: (periodId, date, shiftTypeId, role, volunteers) =>
      cancellationOrderFor(db, periodId, date, shiftTypeId, role, volunteers),
    cancelForCensus: (periodId, date, shiftTypeId, role, volunteers, nurseId) =>
      cancelForCensus(db, periodId, date, shiftTypeId, role, volunteers, nurseId),
    recordHoldover: (input) => transact(db, (tx) => recordHoldover(tx, input, ACTOR)),
  };
}
