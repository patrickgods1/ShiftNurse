/**
 * Simulating and scoring one candidate change.
 *
 * Every resolution option is a hypothetical change applied to a copy of the schedule; this is
 * the half of resolution that measures it — violations introduced, made worse and cleared,
 * slots closed, fairness, dollars — and turns that into a ranked `Resolution`. It lives apart
 * from candidate generation so the gate and the score formula (see `scoreResolution`) have one
 * home: a change to how options are judged must not be made in the code that merely proposes
 * them.
 */

import type { Assignment, Id, TimeOffRequest } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { Violation } from '../rules/types.js';
import { diffViolations, type ViolationDiff, violationKey } from '../rules/violation-diff.js';
import type { ObjectiveWeights } from '../solver/types.js';
import type { ConflictEngine, SimState } from './engine.js';
import { costImpact, fairnessImpact } from './impact.js';
import type {
  Conflict,
  Resolution,
  ResolutionAction,
  ResolutionImpact,
  ResolutionKind,
} from './types.js';

/** Hard codes the gate does not count: floors and coverage, which are measured, not caused. */
const MEASURED_HARD_CODES = new Set(['under_contracted_hours', 'understaffed', 'ratio_breach']);

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/**
 * Higher is better:
 *
 *     score = hardShortfall   × (−shortfallPriceDelta)      convex in slots short per shift (D10)
 *           − targetShortfall × targetShortfallDelta        slots left below target
 *           + fairness        × fairness.delta              unit mean composite, in points
 *           − cost            × cost.pessimisticDelta       dollars added, unpriced at the ceiling
 *           − targetShortfall × softViolationsIntroduced    each advisory warning raised
 *
 * The shortfall term is Generate's: the k-th slot short on one shift costs k × hardShortfall, so
 * a nurse on a shift three short is worth three slots and one on a shift one short is worth one.
 * A linear term would rank the two alike, which is the disagreement D10 removed from the solver.
 * The target term is the solver's too: a cell left below its soft target is a cost there, so it
 * must be one here, or a move off a cell at target would look free.
 * Cost reads `pessimisticDelta`, which equals `delta` when everything is priced and prices an
 * unpriced shift at the unit's highest rate, so a nurse with no rate on file never ranks as free.
 *
 * With the default weights closing a lone short slot is worth 3000, one fairness point 30, one
 * dollar 0.05 and one new warning 60 — so covering the shift always beats not covering it, and
 * among the nurses who can, a $600 saving and a one-point fairness swing weigh the same, as they
 * do in the solver's objective. `accept_shortfall` changes nothing and scores 0.
 */
export function scoreResolution(impact: ResolutionImpact, weights: ObjectiveWeights): number {
  return (
    weights.hardShortfall * -impact.shortfallPriceDelta -
    weights.targetShortfall * impact.targetShortfallDelta +
    weights.fairness * impact.fairness.delta -
    weights.cost * impact.cost.pessimisticDelta -
    weights.targetShortfall * impact.softViolationsIntroduced.length
  );
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface ShiftRef {
  date: IsoDate;
  shiftTypeId: Id;
}

/** A hypothetical change: the world after it, and what it touched. */
export interface Change {
  kind: ResolutionKind;
  idSuffix: string;
  actions: ResolutionAction[];
  assignments: readonly Assignment[];
  timeOff: readonly TimeOffRequest[];
  touchedNurses: readonly Id[];
  touchedShifts: readonly ShiftRef[];
  /** Nurses the card and the audit entry name. */
  nurseIds: Id[];
  /**
   * A function when the wording depends on the outcome: whether a shift is paid at overtime
   * is only known once the nurse's week has been priced.
   */
  title: string | ((impact: ResolutionImpact) => string);
  /** Builds the description once the impact is known. */
  describe: (impact: ResolutionImpact) => string;
}

export type Simulated = { ok: true; resolution: Resolution } | { ok: false; hardCodes: string[] };

/**
 * `before` is what the impact is measured against. `known` is the schedule as it stands today
 * when that differs (the competing-time-off premise approves everything first): a violation
 * already present today is not something this option introduced, even if the premise happened
 * to lack it — an empty roster has no missing charge nurse, the real one may well.
 */
export function simulate(
  engine: ConflictEngine,
  before: SimState,
  conflict: Conflict,
  change: Change,
  weights: ObjectiveWeights,
  known: SimState = before,
): Simulated {
  const after = engine.state(change.assignments, change.timeOff, before);

  // Judged by identity and amount: a weekly-hours breach keeps its key however far past the cap
  // the week goes, so a key-only diff would let an option push a nurse from 60 h to 72 h.
  const afterList = collectViolations(after, change);
  const vsBefore = diffViolations(collectViolations(before, change), afterList);
  const vsKnown =
    known === before ? vsBefore : diffViolations(collectViolations(known, change), afterList);
  // `diffViolations` returns the very objects it was given, so membership is by reference.
  const raisedBy = (d: ViolationDiff) =>
    new Set<Violation>([...d.introduced, ...d.worsened.map((w) => w.after)]);
  const raisedVsBefore = raisedBy(vsBefore);
  const raisedVsKnown = raisedBy(vsKnown);
  const raised = afterList.filter((v) => raisedVsBefore.has(v) && raisedVsKnown.has(v));

  const hardCodes = raised
    .filter((v) => v.severity === 'hard' && !MEASURED_HARD_CODES.has(v.code))
    .map((v) => v.code);
  if (hardCodes.length > 0) return { ok: false, hardCodes };

  // Cleared against either schedule, as long as it is not counted twice.
  const cleared = [...vsBefore.cleared];
  if (vsKnown !== vsBefore) {
    const clearedKeys = new Set(vsBefore.cleared.map(violationKey));
    cleared.push(...vsKnown.cleared.filter((v) => !clearedKeys.has(violationKey(v))));
  }

  const shortfallBefore = before.hardShortfall();
  const shortfallAfter = after.hardShortfall();
  const impact: ResolutionImpact = {
    coverage: {
      hardShortfallBefore: shortfallBefore,
      hardShortfallAfter: shortfallAfter,
      delta: shortfallAfter - shortfallBefore,
    },
    fairness: fairnessImpact(before, after),
    cost: costImpact(engine, before, after, change.touchedNurses),
    softViolationsIntroduced: raised.filter((v) => v.severity === 'soft'),
    softViolationsCleared: cleared.filter((v) => v.severity === 'soft'),
    shortfallPriceDelta: after.shortfallPrice() - before.shortfallPrice(),
    targetShortfallDelta: after.targetShortfall() - before.targetShortfall(),
  };

  return {
    ok: true,
    resolution: {
      id: `${conflict.id}/${change.kind}:${change.idSuffix}`,
      conflictId: conflict.id,
      kind: change.kind,
      title: typeof change.title === 'function' ? change.title(impact) : change.title,
      description: change.describe(impact),
      actions: change.actions,
      impact,
      score: scoreResolution(impact, weights),
      nurseIds: change.nurseIds,
      closesConflict: closes(after, conflict),
    },
  };
}

/**
 * Violations of the touched nurses and shifts, each nurse and each cell judged once. A list, not
 * a map: two breaches sharing a key stay two entries for `diffViolations` to pair, and a cell
 * reached from two touched shifts is not judged twice into a phantom second breach.
 */
export function collectViolations(state: SimState, change: Change): Violation[] {
  const out: Violation[] = [];
  for (const nurseId of new Set(change.touchedNurses)) out.push(...state.nurseViolations(nurseId));
  const cells = new Set<string>();
  for (const { date, shiftTypeId } of change.touchedShifts) {
    for (const cell of state.shiftCellsAround(date, shiftTypeId)) {
      const key = `${cell.date}::${cell.shiftTypeId}`;
      if (cells.has(key)) continue;
      cells.add(key);
      out.push(...state.shiftViolations(cell.date, cell.shiftTypeId));
    }
  }
  return out;
}

/** Whether the world after the change no longer contains the conflict at all. */
function closes(after: SimState, conflict: Conflict): boolean {
  if (conflict.kind === 'scheduled_on_leave') {
    const nurseId = conflict.nurseIds[0];
    const timeOffId = conflict.timeOffIds[0];
    if (!nurseId) return false;
    return !after
      .nurseViolations(nurseId)
      .some(
        (v) =>
          v.code === 'works_during_approved_time_off' && v.details?.timeOffRequestId === timeOffId,
      );
  }
  if (conflict.kind === 'fte') {
    // An hours finding has no cell; it is gone when the nurse has no finding of that code
    // over the same dates (the pay period or work week it was raised for).
    const nurseId = conflict.nurseIds[0];
    if (!nurseId) return false;
    const dates = conflict.dates.join(',');
    return !after
      .nurseViolations(nurseId)
      .some((v) => v.code === conflict.details.code && v.dates.join(',') === dates);
  }
  const date = conflict.dates[0];
  if (!date || !conflict.shiftTypeId) return false;
  if (conflict.kind === 'credential') {
    const credentialId = String(conflict.details.credentialId);
    return !after
      .shiftViolations(date, conflict.shiftTypeId)
      .some(
        (v) => v.code === 'missing_credential' && String(v.details?.credentialId) === credentialId,
      );
  }
  if (!conflict.role) return false;
  return after.slotShortfall(date, conflict.shiftTypeId, conflict.role) === 0;
}
