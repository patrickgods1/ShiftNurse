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
 * itself introduces counts against them. `world` — the schedule with the absent nurse actually
 * removed — is used only for what depends on the call-off having happened: who is free, who is
 * on leave, the shortfall, and the fairness burden a pickup would move.
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
import { nurseName } from '../conflicts/text.js';
import { diffViolations } from '../conflicts/violation-diff.js';
import type { Assignment, Id, Nurse } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import { approvedLeaveOn } from '../rules/availability-rules.js';
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
  const hasCharge = world.view
    .onShift(date, shiftType.id)
    .some((v) => v.assignment.isCharge && v.nurse.isChargeEligible);

  const candidates: ReplacementCandidate[] = [];
  const excluded: ExcludedNurse[] = [];

  for (const nurse of engine.activeNurses) {
    if (nurse.id === absentNurse.id) continue;
    if (nurse.role !== absentNurse.role) continue;

    const label = `${nurseName(nurse)} (${nurse.role})`;

    if (world.view.isAssignedOn(nurse.id, date)) {
      excluded.push({
        nurseId: nurse.id,
        label,
        reason: `Already scheduled on ${date} (${shiftAbbreviationsOn(world, nurse.id, date)})`,
      });
      continue;
    }

    if (approvedLeaveOn(world.ctx, nurse.id, date)) {
      excluded.push({ nurseId: nurse.id, label, reason: 'On approved leave' });
      continue;
    }

    const outcome = tryNurse(engine, before, remaining, input, {
      nurse,
      date,
      shiftType,
      hasCharge,
    });

    if (outcome.ok) {
      candidates.push({
        nurseId: nurse.id,
        label,
        ...(nurse.phone !== undefined ? { phone: nurse.phone } : {}),
        payTier: outcome.payTier,
        assignment: outcome.row,
        cost: costImpact(engine, world, outcome.after, [nurse.id]),
        burdenIndex: burdenByNurse.get(nurse.id) ?? 0,
        ...(input.lastCalledAt[nurse.id] !== undefined
          ? { lastCalledAt: input.lastCalledAt[nurse.id] }
          : {}),
        softViolationsIntroduced: outcome.softViolationsIntroduced,
        rank: 0,
      });
    } else {
      excluded.push({ nurseId: nurse.id, label, reason: outcome.reason });
    }
  }

  candidates.sort((a, b) => compareCandidates(a, b));
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
      after: SimState;
      softViolationsIntroduced: Violation[];
    }
  | { ok: false; reason: string };

function tryNurse(
  engine: ConflictEngine,
  before: SimState,
  remaining: readonly Assignment[],
  input: ReplacementInput,
  ctx: TryContext,
): TryOutcome {
  const { nurse, date, shiftType, hasCharge } = ctx;

  const attempt = (isOvertime: boolean) => {
    const row: Omit<Assignment, 'id'> = {
      periodId: engine.input.period.id,
      nurseId: nurse.id,
      shiftTypeId: shiftType.id,
      date,
      source: 'callout',
      isLocked: false,
      isCharge: !hasCharge && nurse.isChargeEligible,
      isOvertime,
    };
    const trial: Assignment = {
      id: `callout-trial:${nurse.id}:${input.absentAssignmentId}`,
      ...row,
    };
    const after = engine.state([...remaining, trial], input.timeOff);
    const nurseDiff = diffViolations(
      before.nurseViolations(nurse.id),
      after.nurseViolations(nurse.id),
    );
    const shiftDiff = diffViolations(
      before.shiftViolations(date, shiftType.id),
      after.shiftViolations(date, shiftType.id),
    );
    const introduced = [...nurseDiff.introduced, ...shiftDiff.introduced];
    const hard = introduced.filter((v) => v.severity === 'hard');
    const soft = introduced.filter((v) => v.severity === 'soft');
    return { row, after, hard, soft };
  };

  const straight = attempt(false);
  if (straight.hard.length === 0) {
    return {
      ok: true,
      payTier: nurse.employmentType === 'agency' ? 'agency' : 'straight',
      row: straight.row,
      after: straight.after,
      softViolationsIntroduced: straight.soft,
    };
  }

  if (straight.hard.every((v) => v.code === 'unauthorised_overtime')) {
    const overtime = attempt(true);
    if (overtime.hard.length === 0) {
      return {
        ok: true,
        payTier: nurse.employmentType === 'agency' ? 'agency' : 'overtime',
        row: overtime.row,
        after: overtime.after,
        softViolationsIntroduced: overtime.soft,
      };
    }
    const v = overtime.hard[0]!;
    return { ok: false, reason: `${v.ruleName} — ${v.message}` };
  }

  const v = straight.hard[0]!;
  return { ok: false, reason: `${v.ruleName} — ${v.message}` };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function compareCandidates(a: ReplacementCandidate, b: ReplacementCandidate): number {
  const tier = PAY_TIER_ORDER.indexOf(a.payTier) - PAY_TIER_ORDER.indexOf(b.payTier);
  if (tier !== 0) return tier;

  const cost = a.cost.delta - b.cost.delta;
  if (cost !== 0) return cost;

  const burden = a.burdenIndex - b.burdenIndex;
  if (burden !== 0) return burden;

  const recency = compareLastCalled(a.lastCalledAt, b.lastCalledAt);
  if (recency !== 0) return recency;

  return a.nurseId.localeCompare(b.nurseId);
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
    .map((v) => world.engine.shiftType(v.assignment.shiftTypeId).abbreviation);
  return abbreviations.join(', ');
}
