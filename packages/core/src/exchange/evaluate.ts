/**
 * Evaluating and planning a shift exchange.
 *
 * ## Why this reuses the conflict engine
 *
 * A trade or giveaway is exactly the kind of hypothetical the conflict engine already answers
 * dozens of times per resolution: "what does the schedule look like with this one change, and
 * what does the rule engine, the fairness scorer and the cost engine say about it?" Building a
 * second simulation path here would let an exchange pass a check the grid disagrees with —
 * `ConflictEngine`/`SimState` are reused verbatim, evaluated only over the nurses and shifts the
 * exchange actually touches, exactly as `conflicts/resolve.ts` does for a resolution candidate.
 *
 * ## Why overtime authorisation is decided, not just checked
 *
 * `max-hours-per-week` raises `unauthorised_overtime` — a hard violation — for a work week past
 * the overtime threshold with no assignment flagged `isOvertime`. A giveaway that hands someone
 * their fourth 12 of the week would fail that check by construction unless the created row is
 * flagged. The recipient always starts at straight time — the giver's overtime flag described the
 * giver's week, not hers — and is flagged authorised only when that is what stands between the
 * plan and a legal schedule. `conflicts/pickup.ts`'s `planPickup` is that shared planner (it also
 * decides who carries charge), used by `evaluateExchange` and `planExchange` alike so the plan an
 * approval writes is exactly the plan the preview was judged against.
 */

import { ConflictEngine, type SimState } from '../conflicts/engine.js';
import { costImpact, fairnessImpact, sumCost } from '../conflicts/impact.js';
import { planPickup } from '../conflicts/pickup.js';
import { dayLabel, dollars, nurseName, plural, signed } from '../conflicts/text.js';
import type { Assignment, Id } from '../domain/entities.js';
import { type IsoDate, shiftWindow } from '../domain/time.js';
import { overtimeHoursAround } from '../rules/hours-rules.js';
import type { Violation } from '../rules/types.js';
import { diffViolations } from '../rules/violation-diff.js';
import type { AssignmentView } from '../schedule/view.js';
import type {
  ExchangeApplication,
  ExchangeEvaluation,
  ExchangeInput,
  ExchangeProposal,
  ExchangeVerdict,
  NurseSideImpact,
} from './types.js';

/** A unit fairness swing worse than this (points, on the 0–100 composite) warrants a warning. */
const FAIRNESS_WARN_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Judge a proposed exchange against the rule engine, fairness scorer and cost engine. */
export function evaluateExchange(input: ExchangeInput): ExchangeEvaluation {
  const engine = new ConflictEngine(input);
  const { offered, requested } = validateProposal(engine, input.proposal);
  const before = engine.baseline();

  const sides = sidesFor(input.proposal, offered, requested);
  const remaining = removeAssignments(input.assignments, offered, requested);
  const { assignments: after, forced, notes } = applySides(engine, before, remaining, sides);
  const afterState = engine.state(after, input.timeOff);

  const requestingSide = sideImpact(input.proposal.requestingNurseId, before, afterState);
  const counterpartySide = sideImpact(input.proposal.counterpartyNurseId, before, afterState);

  const shiftRefs = uniqueShiftRefs(requested ? [offered, requested] : [offered]);
  const shiftIntroduced: Violation[] = [];
  for (const ref of shiftRefs) {
    const diff = diffViolations(
      before.shiftViolationsAround(ref.date, ref.shiftTypeId),
      afterState.shiftViolationsAround(ref.date, ref.shiftTypeId),
    );
    shiftIntroduced.push(...diff.introduced, ...diff.worsened.map((w) => w.after));
  }
  const shiftHard = shiftIntroduced.filter((v) => v.severity === 'hard');
  const shiftSoft = shiftIntroduced.filter((v) => v.severity === 'soft');

  const fairness = fairnessImpact(before, afterState);
  const cost = costImpact(engine, before, afterState, [
    input.proposal.requestingNurseId,
    input.proposal.counterpartyNurseId,
  ]);

  const hardShortfallBefore = before.hardShortfall();
  const hardShortfallAfter = afterState.hardShortfall();

  const blockers: string[] = [
    ...requestingSide.hardViolations.map(blockerLine),
    ...counterpartySide.hardViolations.map(blockerLine),
    ...shiftHard.map(blockerLine),
  ];
  if (hardShortfallAfter > hardShortfallBefore) {
    blockers.push(
      `Blocked: coverage — this exchange leaves ${plural(hardShortfallAfter - hardShortfallBefore, 'nurse-slot')} ` +
        "short of the hard minimum that today's schedule is not.",
    );
  }

  const warnings: string[] = [
    ...requestingSide.softViolationsIntroduced.map(warningLine),
    ...counterpartySide.softViolationsIntroduced.map(warningLine),
    ...shiftSoft.map(warningLine),
  ];
  if (blockers.length === 0 && fairness.delta < -FAIRNESS_WARN_THRESHOLD) {
    warnings.push(
      `Drops unit fairness ${fairness.unitScoreBefore.toFixed(1)} → ${fairness.unitScoreAfter.toFixed(1)} ` +
        `(${signed(fairness.delta)}).`,
    );
  }
  if (blockers.length === 0) {
    for (const side of forced) {
      const otHours = overtimeHoursFor(
        engine,
        afterState,
        side.recipient,
        // Its start, so a week that begins at a shift change files the shift where the rule does.
        shiftWindow(side.source.date, engine.shiftType(side.source.shiftTypeId)).startMinute,
      );
      // The pickup's own price: the exchange's net would show a trade forcing overtime on both
      // sides as the same dollars twice, and a giveaway as its cost less the giver's saved shift.
      const pickupCost = costImpact(engine, before, afterState, [side.recipient]).delta;
      warnings.push(
        `Creates ${plural(Math.round(otHours), 'hour')} of overtime for ` +
          `${nurseName(engine.nurse(side.recipient))}, ${signedDollars(pickupCost)}.`,
      );
    }
  }

  const verdict: ExchangeVerdict =
    blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warn' : 'ok';

  return {
    verdict,
    blockers,
    warnings,
    requesting: requestingSide,
    counterparty: counterpartySide,
    fairness,
    cost,
    shiftViolationsIntroduced: shiftHard,
    notes,
    after: afterState.view.toAssignments(),
  };
}

/** The delete/create rows an approval writes. Pure: nothing here persists anything. */
export function planExchange(input: ExchangeInput): ExchangeApplication {
  const engine = new ConflictEngine(input);
  const { offered, requested } = validateProposal(engine, input.proposal);
  const before = engine.baseline();

  const sides = sidesFor(input.proposal, offered, requested);
  const remaining = removeAssignments(input.assignments, offered, requested);
  const { rows, chargeTo } = applySides(engine, before, remaining, sides);

  const remove = requested ? [offered.id, requested.id] : [offered.id];
  return { remove, create: rows, ...(chargeTo.length > 0 ? { chargeTo } : {}) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedProposal {
  offered: Assignment;
  requested?: Assignment;
}

function validateProposal(engine: ConflictEngine, proposal: ExchangeProposal): ValidatedProposal {
  const {
    kind,
    requestingNurseId,
    counterpartyNurseId,
    offeredAssignmentId,
    requestedAssignmentId,
  } = proposal;

  if (requestingNurseId === counterpartyNurseId) {
    throw new Error('An exchange needs two different nurses.');
  }
  // Throws loudly on an unknown nurse id.
  engine.nurse(requestingNurseId);
  engine.nurse(counterpartyNurseId);

  if (kind === 'trade' && !requestedAssignmentId) {
    throw new Error('A trade must name the assignment the counterparty gives up in return.');
  }
  if (kind === 'giveaway' && requestedAssignmentId) {
    throw new Error('A giveaway takes nothing back; to get a shift in return, propose a trade.');
  }

  const offered = findHeldAssignment(engine, offeredAssignmentId, requestingNurseId);
  const requested = requestedAssignmentId
    ? findHeldAssignment(engine, requestedAssignmentId, counterpartyNurseId)
    : undefined;

  return { offered, requested };
}

function findHeldAssignment(
  engine: ConflictEngine,
  assignmentId: Id,
  expectedNurseId: Id,
): Assignment {
  const inPeriod = engine.input.assignments.find((a) => a.id === assignmentId);
  if (!inPeriod) {
    const inTail = engine.input.priorAssignments.find((a) => a.id === assignmentId);
    // The loader carries a floated-off shift in the tail as busy time (D20); it is this
    // period's date, so "outside the period" would send the manager looking in the wrong place.
    if (inTail?.floatedTo !== undefined) {
      throw new Error(
        `${nurseName(engine.nurse(inTail.nurseId))} was floated to ${inTail.floatedTo} for that shift; it cannot be traded.`,
      );
    }
    if (inTail) {
      throw new Error(
        'That shift is outside this schedule period; only this period’s shifts can be exchanged.',
      );
    }
    throw new Error('That shift is no longer on this schedule.');
  }
  if (inPeriod.nurseId !== expectedNurseId) {
    throw new Error(
      `That shift belongs to ${nurseName(engine.nurse(inPeriod.nurseId))}, not ` +
        `${nurseName(engine.nurse(expectedNurseId))}.`,
    );
  }
  if (inPeriod.isLocked) {
    throw new Error('That shift is locked; unlock it before proposing an exchange that moves it.');
  }
  return inPeriod;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** One nurse taking over one of the original assignment's shifts. */
interface Side {
  recipient: Id;
  source: Assignment;
}

function sidesFor(proposal: ExchangeProposal, offered: Assignment, requested?: Assignment): Side[] {
  return requested
    ? [
        { recipient: proposal.counterpartyNurseId, source: offered },
        { recipient: proposal.requestingNurseId, source: requested },
      ]
    : [{ recipient: proposal.counterpartyNurseId, source: offered }];
}

function removeAssignments(
  assignments: readonly Assignment[],
  offered: Assignment,
  requested?: Assignment,
): Assignment[] {
  const removed = new Set(requested ? [offered.id, requested.id] : [offered.id]);
  return assignments.filter((a) => !removed.has(a.id));
}

/**
 * Builds the created rows side by side, checking each pickup against the schedule as it stands
 * after every side already applied (a trade's two new rows never depend on each other's legality,
 * but building them in the same pass keeps `planExchange` and `evaluateExchange` doing identical
 * work).
 */
function applySides(
  engine: ConflictEngine,
  before: SimState,
  remaining: readonly Assignment[],
  sides: readonly Side[],
): {
  assignments: Assignment[];
  rows: Omit<Assignment, 'id'>[];
  forced: Side[];
  chargeTo: Id[];
  notes: string[];
} {
  let working: Assignment[] = [...remaining];
  const rows: Omit<Assignment, 'id'>[] = [];
  const forced: Side[] = [];
  const chargeTo: Id[] = [];
  const notes: string[] = [];

  sides.forEach((side, index) => {
    const recipient = engine.nurse(side.recipient);
    const plan = planPickup(engine, before, working, engine.input.timeOff, {
      recipient,
      date: side.source.date,
      shiftTypeId: side.source.shiftTypeId,
      periodId: side.source.periodId,
      source: 'manual',
      needsCharge: side.source.isCharge,
      ...(side.source.notes !== undefined ? { notes: side.source.notes } : {}),
      trialId: `exchange:${index}:${side.recipient}:${side.source.id}`,
    });
    working = plan.assignments;
    rows.push(plan.row);
    if (plan.forcedOvertime) forced.push(side);
    if (plan.chargeMovedTo) {
      const mover = engine.nurse(plan.chargeMovedTo.nurseId);
      chargeTo.push(plan.chargeMovedTo.id);
      notes.push(
        `${nurseName(mover)} takes charge of ${dayLabel(side.source.date)} ` +
          `${engine.shiftType(side.source.shiftTypeId).abbreviation}, since ` +
          `${nurseName(recipient)} cannot take charge.`,
      );
    }
  });

  return { assignments: working, rows, forced, chargeTo, notes };
}

function overtimeHoursFor(
  engine: ConflictEngine,
  state: SimState,
  nurseId: Id,
  startMinute: number,
): number {
  return overtimeHoursAround(
    state.view,
    nurseId,
    startMinute,
    engine.maxHoursParams,
    engine.input.unit,
    state.ctx.paidLeaveByNurse.get(nurseId),
    state.ctx,
  );
}

function sideImpact(nurseId: Id, before: SimState, after: SimState): NurseSideImpact {
  const diff = diffViolations(before.nurseViolations(nurseId), after.nurseViolations(nurseId));
  // A breach the exchange deepens (more hours over a cap already exceeded) keeps its key, so
  // `introduced` alone would wave it through.
  const changed = [...diff.introduced, ...diff.worsened.map((w) => w.after)];
  return {
    nurseId,
    hoursBefore: sumHours(before.view.assignmentsFor(nurseId)),
    hoursAfter: sumHours(after.view.assignmentsFor(nurseId)),
    fairnessBefore: before.fairness().byNurse.get(nurseId) ?? 0,
    fairnessAfter: after.fairness().byNurse.get(nurseId) ?? 0,
    dollarsBefore: sumCost(before.nurseCost(nurseId)),
    dollarsAfter: sumCost(after.nurseCost(nurseId)),
    hardViolations: changed.filter((v) => v.severity === 'hard'),
    softViolationsIntroduced: changed.filter((v) => v.severity === 'soft'),
    softViolationsCleared: diff.cleared.filter((v) => v.severity === 'soft'),
  };
}

function sumHours(views: readonly AssignmentView[]): number {
  return views.reduce((acc, v) => acc + v.paidHours, 0);
}

interface ShiftRef {
  date: IsoDate;
  shiftTypeId: Id;
}

function uniqueShiftRefs(assignments: readonly Assignment[]): ShiftRef[] {
  const seen = new Map<string, ShiftRef>();
  for (const a of assignments) {
    seen.set(`${a.date}::${a.shiftTypeId}`, { date: a.date, shiftTypeId: a.shiftTypeId });
  }
  return [...seen.values()];
}

function blockerLine(v: Violation): string {
  return `Blocked: ${v.ruleName} — ${v.message}`;
}

function warningLine(v: Violation): string {
  return `Warning: ${v.ruleName} — ${v.message}`;
}

function signedDollars(delta: number): string {
  return delta >= 0 ? `+${dollars(delta)}` : dollars(delta);
}
