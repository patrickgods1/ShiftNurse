/**
 * Finding a legal replacement for a call-off.
 *
 * ## Why this reuses the conflict engine
 *
 * "Who can legally take this shift right now?" is the same hypothetical the conflict engine
 * already answers for resolutions and exchanges: build the schedule minus the change, add the
 * candidate back, and ask the rule engine, the fairness scorer and the cost engine what
 * changed. Building a second simulation path here would let a name reach the call list that
 * the grid would immediately flag red. `ConflictEngine`/`SimState` and the diff/impact helpers
 * are reused verbatim, exactly as `exchange/evaluate.ts` does.
 *
 * ## Why the diff is against `before`, not `world`
 *
 * `before` is the schedule as it actually stands, absent nurse still on it — that is the state
 * every other rule violation on the grid is currently judged against. Diffing a candidate's
 * trial assignment against `before` means a violation that already existed on that nurse or
 * that shift (unrelated to this call-off) is never blamed on the pickup; only what the pickup
 * itself introduces, or makes worse (more hours past a cap already exceeded), counts against
 * them. `world` — the schedule with the absent nurse actually removed — is used only for what
 * depends on the call-off having happened: who is free, who is on leave, the shortfall, and the
 * fairness burden a pickup would move.
 *
 * ## Why a locked assignment is not refused here
 *
 * A call-off is a fact, not a request the manager approves — the nurse did not show up whether
 * or not the shift was locked. `exchange/evaluate.ts` refuses to move a locked assignment
 * because a trade or giveaway is a *choice*; a call-off is not, so the same guard does not
 * belong in this path.
 */

import { ConflictEngine, type SimState } from '../conflicts/engine.js';
import { costImpact } from '../conflicts/impact.js';
import { planPickup } from '../conflicts/pickup.js';
import { nurseName } from '../conflicts/text.js';
import type { Assignment, Id, Nurse, ShiftType } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  describeDate,
  type IsoDate,
  shiftWindow,
  windowsOverlap,
} from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import { compareSeniority } from '../roster/seniority.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
import { canTakeCharge } from '../rules/coverage-rules.js';
import { volunteeredOn } from '../rules/mandatory-overtime.js';
import { outsideMembership } from '../rules/membership.js';
import type { Violation } from '../rules/types.js';
import {
  type ExcludedNurse,
  PAY_TIER_ORDER,
  type PayTier,
  type ReplacementCandidate,
  type ReplacementInput,
  type ReplacementReport,
} from './types.js';

export function findReplacements(input: ReplacementInput): ReplacementReport {
  const engine = new ConflictEngine(input);
  const before = engine.baseline();

  const absent = findAbsentAssignment(engine, input.absentAssignmentId);
  const absentNurse = engine.nurse(absent.nurseId);
  const shiftType = engine.shiftType(absent.shiftTypeId);
  const date = absent.date;

  const remaining = input.assignments.filter((a) => a.id !== absent.id);
  const world = engine.state(remaining, input.timeOff);
  const shortfall = world.slotShortfall(date, shiftType.id, absentNurse.role);

  const burdenByNurse = burdenIndexByNurse(engine, world);
  // A shift inside another runs under that shift's charge nurse, so nobody is made charge on it.
  const hasCharge =
    shiftType.withinShiftTypeId !== null ||
    world.view
      .onShift(date, shiftType.id)
      .some((v) => v.assignment.isCharge && canTakeCharge(v.nurse, engine.coverageParams));
  // Under a licensed ratio an RN stands in an LVN's place in the pool; the rules then say
  // whether the shift also needs the LVN herself (a coverage floor).
  const rnMayFillLpn =
    absentNurse.role === 'LPN' && engine.demand.get(date, shiftType.id)?.licensed !== undefined;

  const candidates: ReplacementCandidate[] = [];
  const excluded: ExcludedNurse[] = [];

  for (const nurse of engine.activeNurses) {
    if (nurse.id === absentNurse.id) continue;
    if (nurse.role !== absentNurse.role && !(rnMayFillLpn && nurse.role === 'RN')) continue;

    const label = `${nurseName(nurse)} (${nurse.role})`;

    // Standby is not "already working": the unit pays her to be phoned for exactly this.
    if (
      world.view
        .timelineFor(nurse.id)
        .some(
          (v) => v.assignment.date === date && !engine.shiftType(v.assignment.shiftTypeId).isOnCall,
        )
    ) {
      excluded.push({
        nurseId: nurse.id,
        label,
        reason: `Already scheduled on ${describeDate(date)} (${shiftAbbreviationsOn(world, nurse.id, date)})`,
      });
      continue;
    }

    if (approvedLeaveOn(world.ctx, nurse.id, date)) {
      excluded.push({ nurseId: nurse.id, label, reason: 'On approved leave' });
      continue;
    }

    if (outsideMembership(world.ctx, nurse.id, date)) {
      excluded.push({ nurseId: nurse.id, label, reason: 'Outside their float dates on this unit' });
      continue;
    }

    const onCall = standbyForWindow(engine, remaining, nurse.id, date, shiftType);
    const outcome = tryNurse(
      engine,
      before,
      onCall.length === 0 ? remaining : remaining.filter((a) => !onCall.includes(a)),
      input,
      { nurse, date, shiftType, hasCharge },
    );

    if (outcome.ok) {
      const moved = outcome.chargeMovedTo;
      const mover = moved ? engine.nurse(moved.nurseId) : undefined;
      candidates.push({
        nurseId: nurse.id,
        label,
        ...(nurse.phone !== undefined ? { phone: nurse.phone } : {}),
        payTier: outcome.payTier,
        assignment: outcome.row,
        ...(moved && mover
          ? {
              chargeMovedTo: {
                assignmentId: moved.id,
                nurseId: mover.id,
                label: `${nurseName(mover)} (${mover.role})`,
              },
            }
          : {}),
        ...(onCall[0] ? { replacesOnCall: { assignmentId: onCall[0].id } } : {}),
        cost: costImpact(engine, world, outcome.after, [nurse.id]),
        burdenIndex: burdenByNurse.get(nurse.id) ?? 0,
        ...(input.lastCalledAt[nurse.id] !== undefined
          ? { lastCalledAt: input.lastCalledAt[nurse.id] }
          : {}),
        ...(input.lastOvertimeOn?.[nurse.id] !== undefined
          ? { lastOvertimeOn: input.lastOvertimeOn[nurse.id] }
          : {}),
        softViolationsIntroduced: outcome.softViolationsIntroduced,
        ...(outcome.row.isOvertime
          ? { volunteeredForOvertime: volunteeredOn(world.ctx, nurse.id, date) }
          : {}),
        rank: 0,
      });
    } else {
      excluded.push({ nurseId: nurse.id, label, reason: outcome.reason });
    }
  }

  const roster = engine.input.unit.overtimeOrder === 'roster';
  const seniority = new Map(engine.activeNurses.map((n) => [n.id, n]));
  candidates.sort((a, b) => compareCandidates(a, b, seniority, roster));
  candidates.forEach((c, index) => {
    c.rank = index + 1;
  });

  return {
    absent: {
      assignmentId: absent.id,
      nurseId: absentNurse.id,
      date,
      shiftTypeId: shiftType.id,
      role: absentNurse.role,
    },
    shortfall,
    candidates,
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function findAbsentAssignment(engine: ConflictEngine, assignmentId: Id): Assignment {
  const inPeriod = engine.input.assignments.find((a) => a.id === assignmentId);
  if (inPeriod) return inPeriod;
  const inTail = engine.input.priorAssignments.some((a) => a.id === assignmentId);
  if (inTail) {
    throw new Error(
      `Assignment ${assignmentId} is outside this period (it is history, not something this ` +
        'schedule can backfill).',
    );
  }
  throw new Error(`Unknown assignment ${assignmentId}.`);
}

// ---------------------------------------------------------------------------
// Fairness burden
// ---------------------------------------------------------------------------

/** Burden index per active nurse over the schedule with the absent nurse's shift gone. */
function burdenIndexByNurse(engine: ConflictEngine, world: SimState): Map<Id, number> {
  const report = scoreFairness({
    nurses: engine.activeNurses,
    current: deriveCounters(world.view, { ...engine.counterCtx, timeOff: world.timeOff }),
    history: engine.input.ledgerHistory,
    scope: {
      asOf: engine.input.period.startDate,
      periodDays: engine.dates.length,
      payPeriodDays: engine.input.unit.payPeriodDays,
    },
    preferences: engine.input.preferences,
    weights: engine.input.ruleSet.fairnessWeights,
  });
  return new Map(report.scores.map((s) => [s.nurseId, s.burdenIndex]));
}

// ---------------------------------------------------------------------------
// Per-nurse simulation
// ---------------------------------------------------------------------------

interface TryContext {
  nurse: Nurse;
  date: IsoDate;
  shiftType: { id: Id };
  hasCharge: boolean;
}

type TryOutcome =
  | {
      ok: true;
      payTier: PayTier;
      row: Omit<Assignment, 'id'>;
      chargeMovedTo?: Assignment;
      after: SimState;
      softViolationsIntroduced: Violation[];
    }
  | { ok: false; reason: string };

/**
 * The pickup is planned by `planPickup`, the one place an exchange and a call-off decide charge
 * and overtime, so a nurse who cannot take charge is still offered when someone on the shift can.
 */
function tryNurse(
  engine: ConflictEngine,
  before: SimState,
  remaining: readonly Assignment[],
  input: ReplacementInput,
  ctx: TryContext,
): TryOutcome {
  const { nurse, date, shiftType, hasCharge } = ctx;
  const plan = planPickup(engine, before, remaining, input.timeOff, {
    recipient: nurse,
    date,
    shiftTypeId: shiftType.id,
    periodId: engine.input.period.id,
    source: 'callout',
    needsCharge: !hasCharge,
    trialId: `callout-trial:${nurse.id}:${input.absentAssignmentId}`,
  });

  const v = plan.hard[0];
  if (v !== undefined) return { ok: false, reason: `${v.ruleName} — ${v.message}` };
  return {
    ok: true,
    payTier:
      nurse.employmentType === 'agency' ? 'agency' : plan.forcedOvertime ? 'overtime' : 'straight',
    row: plan.row,
    ...(plan.chargeMovedTo ? { chargeMovedTo: plan.chargeMovedTo } : {}),
    after: plan.after,
    softViolationsIntroduced: plan.soft,
  };
}

/**
 * The nurse's standby rows whose window overlaps the absent shift's — she is already paid to be
 * phoned for this window, so taking the shift replaces the standby rather than stacking on it.
 * The day either side is searched because a standby dated yesterday can run into today's shift.
 * The overlap is judged on the wall-clock windows (half-open), not on a night flag: a standby that
 * ends at 07:00 is not on call for a shift that starts at 07:00, and stays to be judged by the
 * rules.
 *
 * Only in-period rows are searched, because a backfill can replace only those. A lookback-tail
 * standby that overlapped a shift on the period's first day is left in the trial for the rules
 * to judge: at worst a nurse who was on call is missed, never a wrong name offered.
 */
function standbyForWindow(
  engine: ConflictEngine,
  remaining: readonly Assignment[],
  nurseId: Id,
  date: IsoDate,
  shiftType: ShiftType,
): Assignment[] {
  const window = shiftWindow(date, shiftType);
  const near = new Set([addDays(date, -1), date, addDays(date, 1)]);
  return remaining
    .filter((a) => {
      if (a.nurseId !== nurseId || !near.has(a.date)) return false;
      const type = engine.shiftType(a.shiftTypeId);
      return type.isOnCall && windowsOverlap(shiftWindow(a.date, type), window);
    })
    .sort((a, b) => compareDates(a.date, b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function compareCandidates(
  a: ReplacementCandidate,
  b: ReplacementCandidate,
  nurses: ReadonlyMap<Id, Nurse>,
  /** The unit orders the overtime tier by the contract rosters rather than by fairness. */
  roster: boolean,
): number {
  // The nurse already paid standby for this window is the one the contract phones first.
  const onCall = Number(b.replacesOnCall !== undefined) - Number(a.replacesOnCall !== undefined);
  if (onCall !== 0) return onCall;

  const tier = PAY_TIER_ORDER.indexOf(a.payTier) - PAY_TIER_ORDER.indexOf(b.payTier);
  if (tier !== 0) return tier;

  if (roster && a.payTier === 'overtime') return compareOvertimeRoster(a, b, nurses);

  // Overtime someone offered before overtime they would have to be asked for.
  const offered =
    Number(b.volunteeredForOvertime ?? false) - Number(a.volunteeredForOvertime ?? false);
  if (offered !== 0) return offered;

  // At the precision the Fairness page shows: a gap the manager cannot see must not outrank
  // "called yesterday".
  const burden = Math.round(a.burdenIndex * 10) - Math.round(b.burdenIndex * 10);
  if (burden !== 0) return burden;

  const recency = compareLastCalled(a.lastCalledAt, b.lastCalledAt);
  if (recency !== 0) return recency;

  // Last, and only within a tier: the tier already carries the cost difference that matters.
  // The pessimistic figure, so a nurse with no rate on file is not called first as "free".
  const cost = a.cost.pessimisticDelta - b.cost.pessimisticDelta;
  if (cost !== 0) return cost;

  // Total and host-locale independent, so the same call-off prints the same list everywhere.
  return compareSeniority(nurses.get(a.nurseId)!, nurses.get(b.nurseId)!);
}

/**
 * The contract's overtime rosters: volunteers in turn (whoever has gone longest without overtime,
 * seniority breaking a tie), then the mandated roster from the most junior nurse up. Cost and
 * burden play no part — the contract, not the budget, says who is asked.
 */
function compareOvertimeRoster(
  a: ReplacementCandidate,
  b: ReplacementCandidate,
  seniority: ReadonlyMap<Id, Nurse>,
): number {
  const aVolunteered = a.volunteeredForOvertime ?? false;
  const bVolunteered = b.volunteeredForOvertime ?? false;
  if (aVolunteered !== bVolunteered) return aVolunteered ? -1 : 1;

  const na = seniority.get(a.nurseId)!;
  const nb = seniority.get(b.nurseId)!;
  // Reverse seniority: the more junior nurse goes first.
  if (!aVolunteered) return compareSeniority(nb, na);

  // A nurse who has never worked overtime sorts before any date.
  if (a.lastOvertimeOn !== b.lastOvertimeOn) {
    if (a.lastOvertimeOn === undefined) return -1;
    if (b.lastOvertimeOn === undefined) return 1;
    return compareDates(a.lastOvertimeOn, b.lastOvertimeOn);
  }
  return compareSeniority(na, nb);
}

/** Never-called (`undefined`) sorts before any timestamp — the finder spreads the calls. */
function compareLastCalled(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a - b;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function shiftAbbreviationsOn(world: SimState, nurseId: Id, date: IsoDate): string {
  const abbreviations = world.view
    .onDate(date)
    .filter((v) => v.nurse.id === nurseId)
    .map((v) => world.engine.shiftType(v.assignment.shiftTypeId))
    .filter((type) => !type.isOnCall)
    .map((type) => type.abbreviation);
  return abbreviations.join(', ');
}
