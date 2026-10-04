/**
 * Candidate generation — the concrete options offered for each kind of conflict.
 *
 * Builds the hypothetical changes (assign a free nurse, authorise overtime, move a same-day
 * shift, lift a shift from someone on leave, deny one of several competing requests) and their
 * card text, and hands each to `simulate` to be judged. Kept apart from the judging so that
 * adding an option is a change here and never touches the gate or the score.
 */

import type { Assignment, Id, NurseRole, TimeOffRequest } from '../domain/entities.js';
import { describeDateRange, type IsoDate } from '../domain/time.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
import { hasValidCredential } from '../rules/coverage-rules.js';
import type { ObjectiveWeights } from '../solver/types.js';
import type { ConflictEngine, SimState } from './engine.js';
import { type Change, type ShiftRef, type Simulated, simulate } from './resolution-score.js';
import { dayLabel, dollars, leaveLabel, nurseName, plural, signed } from './text.js';
import type { Conflict, Resolution, ResolutionAction, ResolutionImpact } from './types.js';

// ---------------------------------------------------------------------------
// Staffing conflicts: assign, authorise overtime, move, deny leave
// ---------------------------------------------------------------------------

export interface SlotTarget {
  role: NurseRole | null;
  credentialId: Id | null;
}

/**
 * What a candidate is layered on. `world` is the schedule the candidate is added to and
 * `before` the one its impact is measured against; they differ only when an assignment is first
 * lifted (`scheduled_on_leave`), in which case `actions` carries that deletion and the world
 * already lacks the shift.
 */
interface Prelude {
  world: SimState;
  before: SimState;
  date: IsoDate;
  shiftTypeId: Id;
  actions: ResolutionAction[];
  touchedNurses: Id[];
  idPrefix: string;
  titlePrefix: string;
  leadIn: string;
  /** Same-day moves make no sense when the point is to take someone off, so the caller opts in. */
  moves: boolean;
}

/** Candidates for a short cell: the conflict's own date and shift, today's schedule as the world. */
export function slotOptions(
  engine: ConflictEngine,
  base: SimState,
  conflict: Conflict,
  weights: ObjectiveWeights,
  target: SlotTarget,
): Resolution[] {
  const date = conflict.dates[0];
  if (!date || !conflict.shiftTypeId) return [];
  return staffingOptions(engine, conflict, weights, target, {
    world: base,
    before: base,
    date,
    shiftTypeId: conflict.shiftTypeId,
    actions: [],
    touchedNurses: [],
    idPrefix: '',
    titlePrefix: '',
    leadIn: '',
    moves: true,
  });
}

function staffingOptions(
  engine: ConflictEngine,
  conflict: Conflict,
  weights: ObjectiveWeights,
  target: SlotTarget,
  prelude: Prelude,
): Resolution[] {
  const { world, before, date } = prelude;
  const shiftType = engine.shiftType(prelude.shiftTypeId);
  const roster = world.view.onShift(date, shiftType.id);
  // A shift inside another runs under that shift's charge nurse, so nobody is made charge on it.
  const hasCharge =
    shiftType.withinShiftTypeId !== null ||
    roster.some((v) => v.assignment.isCharge && v.nurse.isChargeEligible);
  const slotLabel = `${dayLabel(date)} ${shiftType.abbreviation}${target.role ? ` ${target.role}` : ''}`;
  const here: ShiftRef = { date, shiftTypeId: shiftType.id };
  const out: Resolution[] = [];

  const fits = (nurseId: Id): boolean => {
    const nurse = engine.nurse(nurseId);
    if (target.role && nurse.role !== target.role) return false;
    if (target.credentialId && !hasValidCredential(world.ctx, nurseId, target.credentialId, date)) {
      return false;
    }
    return true;
  };

  // --- Free nurses: straight time, else authorised overtime; via a denial if a request is pending.
  for (const nurse of engine.activeNurses) {
    if (!fits(nurse.id)) continue;
    if (world.view.isAssignedOn(nurse.id, date)) continue;
    if (approvedLeaveOn(world.ctx, nurse.id, date)) continue;
    const pending = world.pendingOn(nurse.id, date);
    const who = `${nurseName(nurse)} (${nurse.role})`;

    const attempt = (isOvertime: boolean): Simulated => {
      const created: Assignment = {
        id: `res:${conflict.id}:${nurse.id}`,
        periodId: engine.input.period.id,
        nurseId: nurse.id,
        shiftTypeId: shiftType.id,
        date,
        source: 'resolution',
        isLocked: false,
        isCharge: !hasCharge && nurse.isChargeEligible,
        isOvertime,
      };
      const create: ResolutionAction = {
        type: 'create_assignment',
        nurseId: nurse.id,
        shiftTypeId: shiftType.id,
        date,
        isCharge: created.isCharge,
        isOvertime,
      };
      const pay = isOvertime ? 'authorised overtime' : 'straight time';
      const denying = pending.length > 0;
      const change: Change = {
        kind: denying ? 'deny_time_off' : isOvertime ? 'authorize_overtime' : 'assign_available',
        idSuffix: `${prelude.idPrefix}${nurse.id}`,
        actions: [
          ...prelude.actions,
          ...pending.map<ResolutionAction>((r) => ({ type: 'deny_time_off', timeOffId: r.id })),
          create,
        ],
        assignments: [...world.assignments, created],
        timeOff: denying
          ? world.timeOff.map((r) =>
              pending.includes(r) ? { ...r, status: 'denied' as const } : r,
            )
          : world.timeOff,
        touchedNurses: [nurse.id, ...prelude.touchedNurses],
        touchedShifts: [here],
        nurseIds: [nurse.id, ...prelude.touchedNurses],
        title:
          prelude.titlePrefix +
          (denying
            ? `Deny ${nurseName(nurse)}'s ${describeRequests(pending)} and assign them — ${pay}`
            : `Assign ${who} — ${pay}`),
        describe: (impact) =>
          [
            prelude.leadIn,
            denying
              ? `Denies ${plural(pending.length, 'pending request')} so ${nurseName(nurse)} can ` +
                `take ${slotLabel} at ${pay}.`
              : `Puts ${who} on ${slotLabel} at ${pay}.`,
            coverageSentence(impact, conflict),
            costSentence(impact, nurse.id, engine),
            fairnessSentence(impact, engine),
            warningsSentence(impact),
          ].join(' '),
      };
      return simulate(engine, before, conflict, change, weights);
    };

    const straight = attempt(false);
    if (straight.ok) {
      out.push(straight.resolution);
      continue;
    }
    // Only the missing authorisation stood in the way: offer the same shift as overtime.
    if (straight.hardCodes.every((c) => c === 'unauthorised_overtime')) {
      const overtime = attempt(true);
      if (overtime.ok) out.push(overtime.resolution);
    }
  }

  // --- Moves off a same-day shift that is above its target for this role.
  for (const view of prelude.moves ? world.view.onDate(date) : []) {
    const a = view.assignment;
    if (a.shiftTypeId === shiftType.id || a.isLocked) continue;
    if (!fits(a.nurseId)) continue;
    const nurse = view.nurse;
    const sourceTarget = engine.demand.targetFor(date, a.shiftTypeId, nurse.role);
    if (world.staffed(date, a.shiftTypeId, nurse.role) <= sourceTarget) continue;
    const moved: Assignment = {
      ...a,
      shiftTypeId: shiftType.id,
      isCharge: !hasCharge && nurse.isChargeEligible,
    };
    const from = view.shiftType.abbreviation;
    const change: Change = {
      kind: 'move_assignment',
      idSuffix: a.id,
      actions: [
        { type: 'move_assignment', assignmentId: a.id, toDate: date, toShiftTypeId: shiftType.id },
      ],
      assignments: world.assignments.map((x) => (x.id === a.id ? moved : x)),
      timeOff: world.timeOff,
      touchedNurses: [nurse.id],
      touchedShifts: [here, { date, shiftTypeId: a.shiftTypeId }],
      nurseIds: [nurse.id],
      title: `Move ${nurseName(nurse)} (${nurse.role}) from ${from} to ${shiftType.abbreviation}`,
      describe: (impact) =>
        [
          `Moves ${nurseName(nurse)} off ${dayLabel(date)} ${from}, which is above its ` +
            `${nurse.role} target, onto ${shiftType.abbreviation}.`,
          coverageSentence(impact, conflict),
          costSentence(impact, nurse.id, engine),
          fairnessSentence(impact, engine),
          warningsSentence(impact),
        ].join(' '),
    };
    const result = simulate(engine, before, conflict, change, weights);
    if (result.ok) out.push(result.resolution);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Rostered during approved leave: take them off, with or without a replacement
// ---------------------------------------------------------------------------

/**
 * The shift cannot stay with this nurse, so every option starts by lifting it. The lift alone
 * is always offered — it is the honest minimum, and it says how short the shift is left — and
 * each affected shift also gets replacement candidates from the ordinary staffing generator,
 * layered on a world where the shift is already gone. A `move_assignment` is deliberately not
 * offered: shuffling someone else onto the shift is a replacement, and the nurse on leave
 * cannot be moved anywhere.
 */
export function leaveOptions(
  engine: ConflictEngine,
  base: SimState,
  conflict: Conflict,
  weights: ObjectiveWeights,
  max: number,
): Resolution[] {
  const nurseId = conflict.nurseIds[0];
  if (!nurseId) return [];
  const nurse = engine.nurse(nurseId);
  const ids = new Set((conflict.details.assignmentIds as Id[] | undefined) ?? []);
  const affected = base.assignments.filter((a) => ids.has(a.id));
  if (affected.length === 0) return [];
  const out: Resolution[] = [];

  // --- Lift every affected shift, replacing none.
  const gone = new Set(affected.map((a) => a.id));
  const shifts = uniqueShifts(affected);
  const shiftLabels = shifts
    .map((s) => `${dayLabel(s.date)} ${engine.shiftType(s.shiftTypeId).abbreviation}`)
    .join(', ');
  const lift: Change = {
    kind: 'remove_assignment',
    idSuffix: 'lift',
    actions: affected.map<ResolutionAction>((a) => ({
      type: 'delete_assignment',
      assignmentId: a.id,
    })),
    assignments: base.assignments.filter((a) => !gone.has(a.id)),
    timeOff: base.timeOff,
    touchedNurses: [nurseId],
    touchedShifts: shifts,
    nurseIds: [nurseId],
    title: `Take ${nurseName(nurse)} off ${plural(affected.length, 'shift')} — no replacement`,
    describe: (impact) =>
      [
        `Lifts ${nurseName(nurse)}'s ${shiftLabels} and leaves the roster as it is.`,
        impact.coverage.delta > 0
          ? `Leaves ${plural(impact.coverage.delta, 'slot')} more short across the period.`
          : 'Leaves no shift short.',
        costSentence(impact, nurseId, engine),
        fairnessSentence(impact, engine),
        warningsSentence(impact),
      ].join(' '),
  };
  const lifted = simulate(engine, base, conflict, lift, weights);
  if (lifted.ok) out.push(lifted.resolution);

  // --- Lift one shift and hand it to someone legal for it.
  const replacements: Resolution[] = [];
  for (const a of affected) {
    const shiftType = engine.shiftType(a.shiftTypeId);
    const world = engine.state(
      base.assignments.filter((x) => x.id !== a.id),
      base.timeOff,
    );
    replacements.push(
      ...staffingOptions(
        engine,
        conflict,
        weights,
        { role: nurse.role, credentialId: null },
        {
          world,
          before: base,
          date: a.date,
          shiftTypeId: a.shiftTypeId,
          actions: [{ type: 'delete_assignment', assignmentId: a.id }],
          touchedNurses: [nurseId],
          idPrefix: `${a.id}:`,
          titlePrefix: `Take ${nurseName(nurse)} off ${dayLabel(a.date)} ${shiftType.abbreviation}; `,
          leadIn: `Lifts ${nurseName(nurse)}'s ${dayLabel(a.date)} ${shiftType.abbreviation}.`,
          moves: false,
        },
      ),
    );
  }
  replacements.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // The lift-only option and the shortfall option always survive the cap.
  out.push(...replacements.slice(0, Math.max(0, max - 2)));
  return out;
}

function describeRequests(requests: readonly TimeOffRequest[]): string {
  return requests
    .map((r) => `${leaveLabel(r.type)} ${describeDateRange(r.startDate, r.endDate)}`)
    .join(' and ');
}

// ---------------------------------------------------------------------------
// Competing time off: deny one, approve the rest
// ---------------------------------------------------------------------------

/**
 * Each option is measured against the conflict's own premise — every competing request
 * approved — so its coverage delta reads as "slots this denial saves", which is the number the
 * manager is weighing. Approving a request lifts that nurse's assignments inside its range,
 * as the desktop does on approval.
 */
export function competingOptions(
  engine: ConflictEngine,
  base: SimState,
  conflict: Conflict,
  weights: ObjectiveWeights,
): Resolution[] {
  const requests = conflict.timeOffIds
    .map((id) => engine.timeOffById.get(id))
    .filter((r): r is TimeOffRequest => r !== undefined && r.status === 'pending');
  if (requests.length === 0) return [];
  const date = conflict.dates[0]!;
  const shiftType = conflict.shiftTypeId ? engine.shiftType(conflict.shiftTypeId) : undefined;
  const slotLabel =
    `${dayLabel(date)}${shiftType ? ` ${shiftType.abbreviation}` : ''} ${conflict.role ?? ''}`.trim();

  const allApproved = decide(base, requests, null);
  const premise = engine.state(allApproved.assignments, allApproved.timeOff);
  const touchedNurses = [...new Set(requests.map((r) => r.nurseId))].sort();
  const touchedShifts = uniqueShifts(allApproved.displaced);

  const out: Resolution[] = [];
  for (const request of requests) {
    const nurse = engine.nurse(request.nurseId);
    const world = decide(base, requests, request.id);
    const others = requests.length - 1;
    const change: Change = {
      kind: 'deny_time_off',
      idSuffix: request.id,
      actions: [{ type: 'deny_time_off', timeOffId: request.id }],
      assignments: world.assignments,
      timeOff: world.timeOff,
      touchedNurses,
      touchedShifts,
      nurseIds: [nurse.id],
      title: `Deny ${nurseName(nurse)}'s ${describeRequests([request])}`,
      describe: (impact) =>
        [
          `Keeps ${nurseName(nurse)} on ${slotLabel} and approves the other ` +
            `${plural(others, 'request')}.`,
          `Against approving all ${requests.length}, that leaves ` +
            `${plural(impact.coverage.hardShortfallAfter, 'slot')} short across the period ` +
            `instead of ${impact.coverage.hardShortfallBefore}.`,
          costSentence(impact, nurse.id, engine),
          fairnessSentence(impact, engine),
          warningsSentence(impact),
        ].join(' '),
    };
    const result = simulate(engine, premise, conflict, change, weights, base);
    if (result.ok) out.push(result.resolution);
  }
  return out;
}

interface Decided {
  assignments: Assignment[];
  timeOff: TimeOffRequest[];
  displaced: Assignment[];
}

/** Approve every request in the set except `denyId` (denied), lifting the approved nurses' shifts. */
function decide(base: SimState, requests: readonly TimeOffRequest[], denyId: Id | null): Decided {
  const ids = new Set(requests.map((r) => r.id));
  const timeOff = base.timeOff.map((r) => {
    if (r.id === denyId) return { ...r, status: 'denied' as const };
    if (ids.has(r.id)) return { ...r, status: 'approved' as const };
    return r;
  });
  const displaced: Assignment[] = [];
  for (const r of requests) {
    if (r.id === denyId) continue;
    displaced.push(...base.assignmentsWithin(r.nurseId, r.startDate, r.endDate));
  }
  const gone = new Set(displaced.map((a) => a.id));
  return {
    assignments: base.assignments.filter((a) => !gone.has(a.id)),
    timeOff,
    displaced,
  };
}

function uniqueShifts(assignments: readonly Assignment[]): ShiftRef[] {
  const seen = new Map<string, ShiftRef>();
  for (const a of assignments) {
    seen.set(`${a.date}::${a.shiftTypeId}`, { date: a.date, shiftTypeId: a.shiftTypeId });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function coverageSentence(impact: ResolutionImpact, conflict: Conflict): string {
  const closed = -impact.coverage.delta;
  if (closed <= 0) return 'Closes none of the shortfall.';
  const of = conflict.magnitude > 0 ? ` of the ${plural(conflict.magnitude, 'slot')} short` : '';
  return `Closes ${plural(closed, 'slot')}${of}${impact.coverage.hardShortfallAfter === 0 ? '; the period is then fully covered' : ''}.`;
}

function costSentence(impact: ResolutionImpact, nurseId: Id, engine: ConflictEngine): string {
  if (!engine.costCtx) return 'No pay data, so the cost is not priced.';
  if (impact.cost.unpriced) {
    return `Cost unknown: no pay rate on file for ${nurseName(engine.nurse(nurseId))}.`;
  }
  if (impact.cost.delta === 0) return 'Costs nothing extra.';
  return impact.cost.delta > 0
    ? `Costs ${dollars(impact.cost.delta)} more.`
    : `Saves ${dollars(-impact.cost.delta)}.`;
}

function fairnessSentence(impact: ResolutionImpact, engine: ConflictEngine): string {
  const f = impact.fairness;
  if (f.affected.length === 0) return 'Fairness is unchanged.';
  const moved = f.affected
    .slice(0, 2)
    .map(
      (x) => `${nurseName(engine.nurse(x.nurseId))} ${x.before.toFixed(0)} → ${x.after.toFixed(0)}`,
    )
    .join(', ');
  return (
    `Unit fairness ${f.unitScoreBefore.toFixed(1)} → ${f.unitScoreAfter.toFixed(1)} ` +
    `(${signed(f.delta)}); ${moved}${f.affected.length > 2 ? ` and ${f.affected.length - 2} more` : ''}.`
  );
}

function warningsSentence(impact: ResolutionImpact): string {
  const raised = impact.softViolationsIntroduced.length;
  const cleared = impact.softViolationsCleared.length;
  if (raised === 0 && cleared === 0) return 'Raises no advisory warnings.';
  const parts: string[] = [];
  if (raised > 0) parts.push(`raises ${plural(raised, 'advisory warning')}`);
  if (cleared > 0) parts.push(`clears ${cleared}`);
  const sentence = parts.join(' and ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
