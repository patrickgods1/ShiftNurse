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
 * flagged, so `planSide` tries the pickup at straight time first and only sets `isOvertime: true`
 * when that is what stands between the plan and a legal schedule — the same "straight time, else
 * authorised overtime" shape `resolve.ts` uses for a resolution candidate. `evaluateExchange` and
 * `planExchange` share this logic (`planSide`) so the plan an approval writes is exactly the plan
 * the preview was judged against.
 */

import { ConflictEngine, type SimState } from '../conflicts/engine.js';
import { costImpact, fairnessImpact, sumCost } from '../conflicts/impact.js';
import { dollars, nurseName, plural, signed } from '../conflicts/text.js';
import { diffViolations } from '../conflicts/violation-diff.js';
import type { Assignment, Id } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { hoursInWeekOf } from '../rules/hours-rules.js';
import type { Violation } from '../rules/types.js';
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
  const { assignments: after, forced } = applySides(engine, before, remaining, sides);
  const afterState = engine.state(after, input.timeOff);

  const requestingSide = sideImpact(input.proposal.requestingNurseId, before, afterState);
  const counterpartySide = sideImpact(input.proposal.counterpartyNurseId, before, afterState);

  const shiftRefs = uniqueShiftRefs(requested ? [offered, requested] : [offered]);
  const shiftIntroduced: Violation[] = [];
  for (const ref of shiftRefs) {
    const diff = diffViolations(
      before.shiftViolations(ref.date, ref.shiftTypeId),
      afterState.shiftViolations(ref.date, ref.shiftTypeId),
    );
    shiftIntroduced.push(...diff.introduced);
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
      const otHours = overtimeHoursFor(engine, afterState, side.recipient, side.source.date);
      warnings.push(
        `Creates ${plural(Math.round(otHours), 'hour')} of overtime for ` +
          `${nurseName(engine.nurse(side.recipient))}, ${signedDollars(cost.delta)}.`,
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
  const { rows } = applySides(engine, before, remaining, sides);

  const remove = requested ? [offered.id, requested.id] : [offered.id];
  return { remove, create: rows };
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
    throw new Error(`An exchange cannot be between a nurse (${requestingNurseId}) and themself.`);
  }
  // Throws loudly on an unknown nurse id.
  engine.nurse(requestingNurseId);
  engine.nurse(counterpartyNurseId);

  if (kind === 'trade' && !requestedAssignmentId) {
    throw new Error('A trade must name the assignment the counterparty gives up in return.');
  }
  if (kind === 'giveaway' && requestedAssignmentId) {
    throw new Error(
      'A giveaway takes nothing back; it must not name a requestedAssignmentId (that makes it a trade).',
    );
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
    const inTail = engine.input.priorAssignments.some((a) => a.id === assignmentId);
    if (inTail) {
      throw new Error(
        `Assignment ${assignmentId} is outside this period (it is history, not something this ` +
          'schedule can exchange).',
      );
    }
    throw new Error(`Unknown assignment ${assignmentId}.`);
  }
  if (inPeriod.nurseId !== expectedNurseId) {
    throw new Error(
      `Assignment ${assignmentId} is held by ${inPeriod.nurseId}, not the stated nurse ${expectedNurseId}.`,
    );
  }
  if (inPeriod.isLocked) {
    throw new Error(
      `Assignment ${assignmentId} is locked; unlock it before proposing an exchange that moves it.`,
    );
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
): { assignments: Assignment[]; rows: Omit<Assignment, 'id'>[]; forced: Side[] } {
  const working: Assignment[] = [...remaining];
  const rows: Omit<Assignment, 'id'>[] = [];
  const forced: Side[] = [];

  sides.forEach((side, index) => {
    const { row, forcedOvertime } = planSide(engine, before, working, side);
    rows.push(row);
    working.push({ id: `exchange:${index}:${side.recipient}:${side.source.id}`, ...row });
    if (forcedOvertime) forced.push(side);
  });

  return { assignments: working, rows, forced };
}

/**
 * Straight time carried across from the original row, unless that would leave the pickup nurse
 * in unauthorised overtime for the week — then, and only then, the new row is flagged authorised.
 */
function planSide(
  engine: ConflictEngine,
  before: SimState,
  working: readonly Assignment[],
  side: Side,
): { row: Omit<Assignment, 'id'>; forcedOvertime: boolean } {
  const base: Omit<Assignment, 'id'> = {
    periodId: side.source.periodId,
    nurseId: side.recipient,
    shiftTypeId: side.source.shiftTypeId,
    date: side.source.date,
    source: 'manual',
    isLocked: false,
    isCharge: side.source.isCharge,
    isOvertime: side.source.isOvertime,
    ...(side.source.notes !== undefined ? { notes: side.source.notes } : {}),
  };
  if (base.isOvertime) return { row: base, forcedOvertime: false };

  const trial: Assignment = { id: `exchange-trial:${side.recipient}:${side.source.id}`, ...base };
  const trialState = engine.state([...working, trial], engine.input.timeOff);
  const priorHard = new Set(
    before
      .nurseViolations(side.recipient)
      .filter((v) => v.severity === 'hard' && v.code === 'unauthorised_overtime')
      .map((v) => v.dates.join(',')),
  );
  const introducesUnauthorisedOt = trialState
    .nurseViolations(side.recipient)
    .some(
      (v) =>
        v.code === 'unauthorised_overtime' &&
        v.severity === 'hard' &&
        !priorHard.has(v.dates.join(',')),
    );

  return {
    row: { ...base, isOvertime: introducesUnauthorisedOt },
    forcedOvertime: introducesUnauthorisedOt,
  };
}

function overtimeHoursFor(
  engine: ConflictEngine,
  state: SimState,
  nurseId: Id,
  date: IsoDate,
): number {
  const hours = hoursInWeekOf(state.view, nurseId, date, engine.maxHoursParams.workWeekStartsOn);
  return Math.max(0, hours - engine.maxHoursParams.overtimeThresholdHours);
}

function sideImpact(nurseId: Id, before: SimState, after: SimState): NurseSideImpact {
  const diff = diffViolations(before.nurseViolations(nurseId), after.nurseViolations(nurseId));
  return {
    nurseId,
    hoursBefore: sumHours(before.view.assignmentsFor(nurseId)),
    hoursAfter: sumHours(after.view.assignmentsFor(nurseId)),
    fairnessBefore: before.fairness().byNurse.get(nurseId) ?? 0,
    fairnessAfter: after.fairness().byNurse.get(nurseId) ?? 0,
    dollarsBefore: sumCost(before.nurseCost(nurseId)),
    dollarsAfter: sumCost(after.nurseCost(nurseId)),
    hardViolations: diff.introduced.filter((v) => v.severity === 'hard'),
    softViolationsIntroduced: diff.introduced.filter((v) => v.severity === 'soft'),
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
