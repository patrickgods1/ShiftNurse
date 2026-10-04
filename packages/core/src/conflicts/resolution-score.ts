/**
 * Simulating and scoring one candidate change.
 *
 * Every resolution option is a hypothetical change applied to a copy of the schedule; this is
 * the half of resolution that measures it — violations introduced and cleared, slots closed,
 * fairness, dollars — and turns that into a ranked `Resolution`. It lives apart from candidate
 * generation so the gate and the score formula (see `scoreResolution`) have one home: a change
 * to how options are judged must not be made in the code that merely proposes them.
 */

import type { Assignment, Id, TimeOffRequest } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { Violation } from '../rules/types.js';
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
import { diffViolations, violationKey } from './violation-diff.js';

/** Hard codes the gate does not count: floors and coverage, which are measured, not caused. */
const MEASURED_HARD_CODES = new Set(['under_contracted_hours', 'understaffed', 'ratio_breach']);

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/**
 * Higher is better:
 *
 *     score = hardShortfall  × (−coverage.delta)            slots closed, period-wide
 *           + fairness       × fairness.delta                unit mean composite, in points
 *           − cost           × cost.delta                    dollars added
 *           − targetShortfall × softViolationsIntroduced     each advisory warning raised
 *
 * With the default weights a closed slot is worth 3000, one fairness point 30, one dollar 0.05
 * and one new warning 60 — so covering the shift always beats not covering it, and among the
 * nurses who can, a $600 saving and a one-point fairness swing weigh the same, as they do in
 * the solver's objective. `accept_shortfall` changes nothing and scores 0.
 */
export function scoreResolution(impact: ResolutionImpact, weights: ObjectiveWeights): number {
  return (
    weights.hardShortfall * -impact.coverage.delta +
    weights.fairness * impact.fairness.delta -
    weights.cost * impact.cost.delta -
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
  title: string;
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
  const after = engine.state(change.assignments, change.timeOff);

  const wasThere = collectViolations(before, change);
  if (known !== before) {
    for (const [key, v] of collectViolations(known, change)) {
      if (!wasThere.has(key)) wasThere.set(key, v);
    }
  }
  const isThere = collectViolations(after, change);
  const { introduced, cleared } = diffViolations([...wasThere.values()], [...isThere.values()]);

  const hardCodes = introduced
    .filter((v) => v.severity === 'hard' && !MEASURED_HARD_CODES.has(v.code))
    .map((v) => v.code);
  if (hardCodes.length > 0) return { ok: false, hardCodes };

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
    softViolationsIntroduced: introduced.filter((v) => v.severity === 'soft'),
    softViolationsCleared: cleared.filter((v) => v.severity === 'soft'),
  };

  return {
    ok: true,
    resolution: {
      id: `${conflict.id}/${change.kind}:${change.idSuffix}`,
      conflictId: conflict.id,
      kind: change.kind,
      title: change.title,
      description: change.describe(impact),
      actions: change.actions,
      impact,
      score: scoreResolution(impact, weights),
      nurseIds: change.nurseIds,
      closesConflict: closes(after, conflict),
    },
  };
}

/** Violations of the touched nurses and shifts, keyed for a before/after diff. */
function collectViolations(state: SimState, change: Change): Map<string, Violation> {
  const out = new Map<string, Violation>();
  for (const nurseId of change.touchedNurses) {
    for (const v of state.nurseViolations(nurseId)) out.set(violationKey(v), v);
  }
  for (const { date, shiftTypeId } of change.touchedShifts) {
    for (const v of state.shiftViolationsAround(date, shiftTypeId)) out.set(violationKey(v), v);
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
