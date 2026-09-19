/**
 * Conflict detection — turning rule violations and pending requests into named problems.
 *
 * ## Why this is a layer over the rule engine and not a rewrite of it
 *
 * Understaffing, ratio breaches, hours and credential gaps are already found by the rules the
 * grid validates with. Re-deriving them here would create a second opinion about what is
 * short, and the day the two disagree the manager stops trusting both. So every conflict that
 * a rule can find is read off that rule's violations; detection adds only what the rules cannot
 * see: a *pending* cluster of requests that will empty a shift if approved (rules read approved
 * leave only), a credential that lapses mid-period, and the dollars over budget.
 *
 * ## One conflict per short cell
 *
 * The coverage floor and the patient ratio are separate rules with separate citations, and the
 * grid shows both. For the manager's work list, though, one cell short of its hard minimum is
 * one problem with one set of ways out, so a cell breached under both standards is one
 * conflict — kind `ratio_breach` when the legal standard is among those broken, since that is
 * the one to fight for — with both required counts in `details`.
 */

import { NURSE_ROLES } from '../acuity/demand.js';
import type { Id, Nurse, NurseRole, TimeOffRequest } from '../domain/entities.js';
import { compareDates, dateInRange, type IsoDate } from '../domain/time.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
import { hasValidCredential } from '../rules/coverage-rules.js';
import type { Violation } from '../rules/types.js';
import { ConflictEngine, type SimState } from './engine.js';
import { dayLabel, dollars, leaveLabel, nameList, nurseName, plural } from './text.js';
import type { Conflict, ConflictInput, ConflictSeverity } from './types.js';

/** Detect every conflict in a period. Pure: the input is never mutated. */
export function detectConflicts(input: ConflictInput): Conflict[] {
  const engine = new ConflictEngine(input);
  return detectWith(engine, engine.baseline());
}

/** Detection on an existing engine and state, so analysis and what-ifs share the indexes. */
export function detectWith(engine: ConflictEngine, state: SimState): Conflict[] {
  const { violations } = state.evaluate();
  return sortConflicts([
    ...staffingConflicts(engine, state, violations),
    ...competingTimeOffConflicts(engine, state),
    ...hoursConflicts(violations),
    ...leaveConflicts(engine, violations),
    ...credentialConflicts(engine, state, violations),
    ...budgetConflicts(engine, state),
  ]);
}

/** Worst first: hard before soft, then by magnitude, then by date; the id settles ties. */
export function sortConflicts(conflicts: Conflict[]): Conflict[] {
  return [...conflicts].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.magnitude - a.magnitude ||
      (a.dates[0] ?? '').localeCompare(b.dates[0] ?? '') ||
      a.id.localeCompare(b.id),
  );
}

function severityRank(severity: ConflictSeverity): number {
  return severity === 'hard' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Staffing
// ---------------------------------------------------------------------------

interface ShortCell {
  date: IsoDate;
  shiftTypeId: Id;
  role: NurseRole;
  staffed: number;
  floorRequired: number;
  ratioRequired: number;
  ratioBreached: boolean;
  hard: boolean;
}

function staffingConflicts(
  engine: ConflictEngine,
  state: SimState,
  violations: readonly Violation[],
): Conflict[] {
  const cells = new Map<string, ShortCell>();
  for (const v of violations) {
    if (v.code !== 'understaffed' && v.code !== 'ratio_breach') continue;
    const d = v.details ?? {};
    const date = v.dates[0];
    if (!date) continue;
    const shiftTypeId = String(d.shiftTypeId) as Id;
    const role = d.role as NurseRole;
    const key = `${date}::${shiftTypeId}::${role}`;
    const cell = cells.get(key) ?? {
      date,
      shiftTypeId,
      role,
      staffed: Number(d.staffed ?? 0),
      floorRequired: 0,
      ratioRequired: 0,
      ratioBreached: false,
      hard: false,
    };
    if (v.code === 'ratio_breach') {
      cell.ratioBreached = true;
      cell.ratioRequired = Number(d.required ?? 0);
    } else {
      cell.floorRequired = Number(d.required ?? 0);
    }
    if (v.severity === 'hard') cell.hard = true;
    cells.set(key, cell);
  }

  const out: Conflict[] = [];
  for (const cell of cells.values()) {
    const shiftType = engine.shiftType(cell.shiftTypeId);
    const required = Math.max(cell.floorRequired, cell.ratioRequired);
    const shortfall = required - cell.staffed;
    const kind = cell.ratioBreached ? 'ratio_breach' : 'understaffing';

    const onLeave = engine.nurses.filter(
      (n) => n.role === cell.role && approvedLeaveOn(state.ctx, n.id, cell.date) !== undefined,
    );
    const leaveIds = onLeave.map((n) => approvedLeaveOn(state.ctx, n.id, cell.date)!.id);
    const pending = pendingCovering(state.timeOff, cell.date).filter(
      (r) => engine.nursesById.get(r.nurseId)?.role === cell.role,
    );

    const standard = !cell.ratioBreached
      ? 'floor'
      : cell.ratioRequired >= cell.floorRequired
        ? 'ratio'
        : `floor; ratio requires ${cell.ratioRequired}`;
    let message =
      `${dayLabel(cell.date)} ${shiftType.abbreviation} ${cell.role}: ${cell.staffed} staffed ` +
      `of ${required} required (${standard})`;
    if (onLeave.length > 0) {
      message += ` — ${nameList(onLeave)} on approved leave`;
    }
    if (pending.length > 0) {
      message += ` — ${plural(pending.length, 'pending request')} overlap`;
    }

    out.push({
      id: `${kind}:${cell.date}:${cell.shiftTypeId}:${cell.role}`,
      kind,
      severity: cell.hard ? 'hard' : 'soft',
      dates: [cell.date],
      shiftTypeId: cell.shiftTypeId,
      role: cell.role,
      nurseIds: onLeave.map((n) => n.id),
      timeOffIds: leaveIds,
      message: `${message}.`,
      magnitude: shortfall,
      details: {
        staffed: cell.staffed,
        required,
        shortfall,
        floorRequired: cell.floorRequired,
        ratioRequired: cell.ratioRequired,
        standard: cell.ratioBreached ? 'ratio' : 'coverage_floor',
        rosterNurseIds: state.view.onShift(cell.date, cell.shiftTypeId).map((v) => v.nurse.id),
        pendingTimeOffIds: pending.map((r) => r.id),
      },
    });
  }
  return out;
}

function pendingCovering(timeOff: readonly TimeOffRequest[], date: IsoDate): TimeOffRequest[] {
  return timeOff.filter((r) => r.status === 'pending' && dateInRange(date, r.startDate, r.endDate));
}

// ---------------------------------------------------------------------------
// Competing time off
// ---------------------------------------------------------------------------

/**
 * For each date, the pending requests touching it are all approved at once — each nurse's
 * assignments inside their requested range are lifted — and any cell that ends up shorter
 * than it is today is a competing-time-off conflict. "Shorter than today" is the test rather
 * than "short": a cell nobody is rostered on yet is an understaffing problem, not evidence that
 * these requests compete, and a conflict must implicate the requests it names.
 */
function competingTimeOffConflicts(engine: ConflictEngine, state: SimState): Conflict[] {
  const pending = state.timeOff.filter((r) => r.status === 'pending');
  if (pending.length === 0) return [];

  const out: Conflict[] = [];
  for (const date of engine.dates) {
    const touching = pending.filter((r) => dateInRange(date, r.startDate, r.endDate));
    if (touching.length === 0) continue;
    const nurseIdsOff = new Set(touching.map((r) => r.nurseId));
    const displaced = state.view.onDate(date).filter((v) => nurseIdsOff.has(v.nurse.id));
    if (displaced.length === 0) continue;

    for (const shiftType of engine.shiftTypes) {
      if (!shiftType.active) continue;
      const roster = state.view.onShift(date, shiftType.id);
      for (const role of NURSE_ROLES) {
        const min = engine.demand.minFor(date, shiftType.id, role);
        if (min <= 0) continue;
        const staffed = roster.filter((v) => v.nurse.role === role);
        const remaining = staffed.filter((v) => !nurseIdsOff.has(v.nurse.id));
        const before = Math.max(0, min - staffed.length);
        const after = Math.max(0, min - remaining.length);
        if (after <= before) continue;

        const leaving = staffed.filter((v) => nurseIdsOff.has(v.nurse.id)).map((v) => v.nurse);
        const leavingIds = new Set(leaving.map((n) => n.id));
        const requests = touching.filter((r) => leavingIds.has(r.nurseId));
        const message =
          `${dayLabel(date)} ${shiftType.abbreviation} ${role}: ` +
          `${plural(requests.length, 'pending request')} (${nameList(leaving)}) overlap — ` +
          `approving all would leave ${remaining.length} of ${min} required.`;
        out.push({
          id: `competing_time_off:${date}:${shiftType.id}:${role}`,
          kind: 'competing_time_off',
          severity: 'soft',
          dates: [date],
          shiftTypeId: shiftType.id,
          role,
          nurseIds: leaving.map((n) => n.id),
          timeOffIds: requests.map((r) => r.id),
          message,
          magnitude: after,
          details: {
            staffed: staffed.length,
            required: min,
            staffedIfAllApproved: remaining.length,
            shortfallNow: before,
            shortfallIfAllApproved: after,
          },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

function hoursConflicts(violations: readonly Violation[]): Conflict[] {
  const out: Conflict[] = [];
  for (const v of violations) {
    let magnitude: number;
    const d = v.details ?? {};
    switch (v.code) {
      case 'under_contracted_hours':
      case 'over_contracted_hours':
        magnitude = Math.abs(Number(d.deltaHours ?? 0));
        break;
      case 'over_max_hours':
        magnitude = Number(d.scheduledHours ?? 0) - Number(d.maxHours ?? 0);
        break;
      case 'unauthorised_overtime':
        magnitude = Number(d.overtimeHours ?? 0);
        break;
      default:
        continue;
    }
    const nurseId = v.nurseIds[0] ?? '';
    out.push({
      id: `fte:${v.code}:${nurseId}:${v.dates[0] ?? ''}`,
      kind: 'fte',
      severity: v.severity,
      dates: [...v.dates],
      nurseIds: [...v.nurseIds],
      timeOffIds: [],
      message: v.message,
      magnitude,
      details: { code: v.code, ruleId: v.ruleId, assignmentIds: v.assignmentIds, ...d },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rostered during approved leave
// ---------------------------------------------------------------------------

/**
 * The time-off rule raises one violation per offending assignment; the manager's problem is
 * "Priya is still on two shifts during her approved leave", so they are folded into one conflict
 * per nurse and request, with every affected date and assignment on it.
 */
function leaveConflicts(engine: ConflictEngine, violations: readonly Violation[]): Conflict[] {
  const groups = new Map<
    string,
    { nurseId: Id; timeOffId: Id; dates: IsoDate[]; assignmentIds: Id[]; hard: boolean }
  >();
  for (const v of violations) {
    if (v.code !== 'works_during_approved_time_off') continue;
    const nurseId = v.nurseIds[0];
    const date = v.dates[0];
    const timeOffId = v.details?.timeOffRequestId;
    if (!nurseId || !date || typeof timeOffId !== 'string') continue;
    const key = `${nurseId}::${timeOffId}`;
    const group = groups.get(key) ?? {
      nurseId,
      timeOffId,
      dates: [],
      assignmentIds: [],
      hard: false,
    };
    if (!group.dates.includes(date)) group.dates.push(date);
    group.assignmentIds.push(...v.assignmentIds);
    if (v.severity === 'hard') group.hard = true;
    groups.set(key, group);
  }

  const out: Conflict[] = [];
  for (const group of groups.values()) {
    const nurse = engine.nurse(group.nurseId);
    const dates = [...group.dates].sort();
    const request = engine.input.timeOff.find((r) => r.id === group.timeOffId);
    const leave = request
      ? `${leaveLabel(request.type)} ${request.startDate}–${request.endDate}`
      : 'approved leave';
    out.push({
      id: `scheduled_on_leave:${group.nurseId}:${group.timeOffId}`,
      kind: 'scheduled_on_leave',
      severity: group.hard ? 'hard' : 'soft',
      dates,
      nurseIds: [group.nurseId],
      timeOffIds: [group.timeOffId],
      message:
        `${nurseName(nurse)} is still rostered on ${plural(group.assignmentIds.length, 'shift')} ` +
        `(${dates.map(dayLabel).join(', ')}) during approved ${leave}.`,
      magnitude: group.assignmentIds.length,
      details: { assignmentIds: [...group.assignmentIds].sort(), timeOffId: group.timeOffId },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function credentialConflicts(
  engine: ConflictEngine,
  state: SimState,
  violations: readonly Violation[],
): Conflict[] {
  const out: Conflict[] = [];
  for (const v of violations) {
    if (v.code !== 'missing_credential') continue;
    const d = v.details ?? {};
    const date = v.dates[0];
    if (!date) continue;
    const shiftTypeId = String(d.shiftTypeId) as Id;
    const credentialId = String(d.credentialId) as Id;
    const role = (d.role ?? null) as NurseRole | null;
    const required = Number(d.required ?? 0);
    const held = Number(d.held ?? 0);
    out.push({
      id: `credential:missing:${date}:${shiftTypeId}:${credentialId}`,
      kind: 'credential',
      severity: v.severity,
      dates: [date],
      shiftTypeId,
      ...(role ? { role } : {}),
      nurseIds: [...v.nurseIds],
      timeOffIds: [],
      message: `${dayLabel(date)} ${engine.shiftType(shiftTypeId).abbreviation}: ${v.message}`,
      magnitude: required - held,
      details: { kind: 'missing', credentialId, credentialCode: d.credentialCode, required, held },
    });
  }

  // A credential that lapses before a shift the nurse is already on. The coverage rule only
  // notices when a shift *requires* it; a lapsed licence on a rostered nurse is a compliance
  // problem regardless, so it is raised here, as advisory, one conflict per nurse and credential.
  const lapsed = new Map<string, { nurse: Nurse; credentialId: Id; dates: IsoDate[] }>();
  for (const view of state.view.assignments()) {
    const held = state.ctx.nurseCredentials.get(view.nurse.id) ?? [];
    for (const record of held) {
      if (!record.expiresOn || compareDates(record.expiresOn, view.assignment.date) >= 0) continue;
      if (hasValidCredential(state.ctx, view.nurse.id, record.credentialId, view.assignment.date)) {
        continue; // Renewed under another record.
      }
      const key = `${view.nurse.id}::${record.credentialId}`;
      const entry = lapsed.get(key) ?? {
        nurse: view.nurse,
        credentialId: record.credentialId,
        dates: [],
      };
      if (!entry.dates.includes(view.assignment.date)) entry.dates.push(view.assignment.date);
      lapsed.set(key, entry);
    }
  }
  for (const entry of lapsed.values()) {
    const dates = [...entry.dates].sort();
    const credential = state.ctx.credentialsById.get(entry.credentialId);
    const code = credential?.code ?? entry.credentialId;
    const expiresOn = (state.ctx.nurseCredentials.get(entry.nurse.id) ?? [])
      .filter((r) => r.credentialId === entry.credentialId && r.expiresOn)
      .map((r) => r.expiresOn!)
      .sort()
      .pop();
    out.push({
      id: `credential:expired:${entry.nurse.id}:${entry.credentialId}`,
      kind: 'credential',
      severity: 'soft',
      dates,
      nurseIds: [entry.nurse.id],
      timeOffIds: [],
      message:
        `${nurseName(entry.nurse)}'s ${code} expires ${expiresOn} but they are rostered on ` +
        `${plural(dates.length, 'shift')} after that, first ${dayLabel(dates[0]!)}.`,
      magnitude: 1,
      details: {
        kind: 'expired',
        credentialId: entry.credentialId,
        credentialCode: code,
        expiresOn,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function budgetConflicts(engine: ConflictEngine, state: SimState): Conflict[] {
  const { budget, cost } = engine.input;
  if (!budget || !cost) return [];
  const total = state.costTotal();
  const over = total - budget.targetDollars;
  if (over <= 0) return [];
  return [
    {
      id: `budget:${engine.input.period.id}`,
      kind: 'budget',
      severity: 'soft',
      dates: [engine.input.period.startDate],
      nurseIds: [],
      timeOffIds: [],
      message:
        `The schedule prices at ${dollars(total)} against a ${dollars(budget.targetDollars)} ` +
        `budget — ${dollars(over)} over.`,
      magnitude: over,
      details: { actualDollars: total, targetDollars: budget.targetDollars },
    },
  ];
}
