/**
 * The greedy seed: a legal, reasonable schedule for annealing to improve on.
 *
 * ## Why most-constrained slot first
 *
 * The slot with the fewest nurses who could still take it is the one most likely to end up
 * unfilled if it waits — a Saturday night for LPNs, the day after everyone's leave. Filling it
 * first while its few candidates are still free costs nothing on easy slots and saves the hard
 * ones. Ties fall to calendar order so the seed is deterministic and reads as a human would
 * build it.
 *
 * ## Why fairness debt decides who gets the slot
 *
 * Among the nurses who *can* take a slot, the pick is the one whose addition raises the
 * objective least — and since every candidate closes the same coverage gap, the difference
 * between them is fairness (who is furthest under their share of nights, weekends, holidays),
 * hours still owed, preferences and cost, in that order of weight. "Highest fairness debt wins"
 * is therefore not a separate heuristic bolted on; it is what the objective says when the
 * coverage term cancels out.
 *
 * ## Three passes
 *
 * 1. Every role's hard minimum on every shift.
 * 2. Every role's soft target.
 * 3. Contracted hours: nurses still short of their FTE take extra shifts wherever the
 *    objective prefers — the unit would rather carry a surplus nurse than pay a grievance.
 *
 * The same passes run over a subset of dates as the "recreate" half of the annealer's
 * ruin-and-recreate move, which is why the function takes an optional date filter.
 */

import { NURSE_ROLES, type ShiftDemand } from '../acuity/demand.js';
import type { Assignment, NurseRole } from '../domain/entities.js';
import type { Shift, SolverModel } from './model.js';

interface Slot {
  shift: Shift;
  role: NurseRole;
  /** Nurses who pass the cheap pre-filter for this slot right now. */
  eligible: number;
}

type Level = (demand: ShiftDemand, role: NurseRole) => number;

const MIN: Level = (d, role) => d.byRole[role].minCount;
const TARGET: Level = (d, role) => d.byRole[role].targetCount;

/**
 * Fill the schedule greedily. Returns every assignment it added, in order, so a caller can
 * undo the pass. `dateIdxs` restricts the pass to those dates' shifts.
 */
export function greedySeed(model: SolverModel, dateIdxs?: ReadonlySet<number>): Assignment[] {
  const added: Assignment[] = [];
  const inScope = (shift: Shift) => dateIdxs === undefined || dateIdxs.has(shift.dateIdx);
  fillLevel(model, MIN, inScope, added);
  fillLevel(model, TARGET, inScope, added);
  fillHours(model, inScope, added);
  return added;
}

function fillLevel(
  model: SolverModel,
  level: Level,
  inScope: (shift: Shift) => boolean,
  added: Assignment[],
): void {
  // A slot none of its eligible nurses may legally take is dead for this pass; without
  // remembering that, the loop would re-pick the same impossible slot forever.
  const dead = new Set<string>();

  for (;;) {
    const slot = mostConstrained(model, level, inScope, dead);
    if (!slot) return;
    const placed = placeBest(model, slot);
    if (placed) added.push(placed);
    else dead.add(`${slot.shift.idx}:${slot.role}`);
  }
}

function mostConstrained(
  model: SolverModel,
  level: Level,
  inScope: (shift: Shift) => boolean,
  dead: ReadonlySet<string>,
): Slot | undefined {
  let best: Slot | undefined;
  for (const shift of model.solvableShifts) {
    if (!inScope(shift) || !shift.demand) continue;
    for (const role of NURSE_ROLES) {
      if (level(shift.demand, role) <= model.staffed(shift, role)) continue;
      if (dead.has(`${shift.idx}:${role}`)) continue;
      let eligible = 0;
      for (const i of model.candidates) if (model.eligible(i, shift, role)) eligible++;
      if (eligible === 0) continue;
      // Fewest options first; then the calendar, so equal slots fill in the order a manager
      // would write them down.
      if (
        !best ||
        eligible < best.eligible ||
        (eligible === best.eligible && shift.idx < best.shift.idx)
      ) {
        best = { shift, role, eligible };
      }
    }
  }
  return best;
}

/** Try candidates in order of objective delta until one passes the rule gate. */
function placeBest(model: SolverModel, slot: Slot): Assignment | undefined {
  const eligible = model.candidates.filter((i) => model.eligible(i, slot.shift, slot.role));
  const ranked = rankCandidates(model, slot.shift, eligible);
  for (const { nurseIdx } of ranked) {
    const candidate = model.make(nurseIdx, slot.shift);
    if (!model.canAdd(nurseIdx, candidate)) continue;
    model.add(candidate);
    return candidate;
  }
  return undefined;
}

interface Ranked {
  nurseIdx: number;
  delta: number;
}

/** Objective delta of adding each candidate, lowest first; ties keep nurse-id order. */
function rankCandidates(model: SolverModel, shift: Shift, candidates: readonly number[]): Ranked[] {
  const before = model.objective();
  const ranked: Ranked[] = [];
  for (const nurseIdx of candidates) {
    const probe = model.make(nurseIdx, shift);
    const token = model.add(probe);
    const delta = model.objective() - before;
    model.undoAdd(probe, token);
    ranked.push({ nurseIdx, delta });
  }
  ranked.sort((a, b) => a.delta - b.delta || a.nurseIdx - b.nurseIdx);
  return ranked;
}

/**
 * Nurses still owed hours pick up extra shifts, most-owed first, as long as each extra shift
 * lowers the objective (its coverage surplus and fairness cost against the hours it repays).
 */
function fillHours(
  model: SolverModel,
  inScope: (shift: Shift) => boolean,
  added: Assignment[],
): void {
  for (;;) {
    const owed = model.candidates
      .map((nurseIdx) => ({ nurseIdx, short: model.hoursShort(nurseIdx) }))
      .filter((x) => x.short > 0)
      .sort((a, b) => b.short - a.short || a.nurseIdx - b.nurseIdx);
    if (owed.length === 0) return;

    let progressed = false;
    for (const { nurseIdx } of owed) {
      const placed = bestExtraShift(model, nurseIdx, inScope);
      if (placed) {
        added.push(placed);
        progressed = true;
        // Re-rank: this nurse may still be the most owed, or someone else may be now.
        break;
      }
    }
    if (!progressed) return;
  }
}

function bestExtraShift(
  model: SolverModel,
  nurseIdx: number,
  inScope: (shift: Shift) => boolean,
): Assignment | undefined {
  const before = model.objective();
  const options: { shift: Shift; delta: number }[] = [];
  for (const shift of model.solvableShifts) {
    if (!inScope(shift) || !model.eligible(nurseIdx, shift, null)) continue;
    const probe = model.make(nurseIdx, shift);
    const token = model.add(probe);
    const delta = model.objective() - before;
    model.undoAdd(probe, token);
    if (delta < 0) options.push({ shift, delta });
  }
  options.sort((a, b) => a.delta - b.delta || a.shift.idx - b.shift.idx);
  for (const { shift } of options) {
    const candidate = model.make(nurseIdx, shift);
    if (!model.canAdd(nurseIdx, candidate)) continue;
    model.add(candidate);
    return candidate;
  }
  return undefined;
}
