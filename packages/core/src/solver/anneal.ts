/**
 * Simulated annealing over the solver model, with a ruin-and-recreate large neighbourhood.
 *
 * Simulated annealing is Kirkpatrick, Gelatt & Vecchi, "Optimization by simulated annealing",
 * Science 220(4598):671–680 (1983), doi:10.1126/science.220.4598.671. Ruin and recreate is
 * Schrimpf, Schneider, Stamm-Wilbrandt & Dueck, "Record breaking optimization results using the
 * ruin and recreate principle", J. Computational Physics 159(2):139–171 (2000),
 * doi:10.1006/jcph.1999.6413.
 *
 * ## Why annealing after a greedy seed
 *
 * The seed fills slots one at a time and never revisits a choice. That leaves the classic
 * local traps: a nurse who took Monday's night because it was the most constrained slot at the
 * time and is now the only one over their share of nights; two nurses who would both be
 * happier with each other's weekends. Annealing walks the neighbourhood of the seed — move a
 * shift to another nurse, swap two shifts, add or drop one — accepting improvements always and
 * setbacks with a probability that falls as the run cools, which is what lets it climb out of
 * a trap the seed walked into.
 *
 * ## Why ruin-and-recreate as well
 *
 * Single-shift moves cannot untangle a whole bad day: fixing one shift breaks the rest rule on
 * the next, whose fix breaks the one after. Periodically the annealer clears every unlocked
 * shift on a couple of adjacent days and rebuilds them with the greedy passes, then judges the
 * result like any other move. It is expensive, so it runs on a fixed cadence rather than a
 * random draw; keeping it deterministic is also what keeps the run reproducible.
 *
 * ## Why block moves
 *
 * Some better schedules sit behind a wall no single-shift move can cross: two nurses whose runs
 * of days and nights should be traded, where every one-day trade breaks the rest rule. The block
 * moves in `block-moves.ts` trade or hand over a whole 2–7 day run at once (the neighbourhood
 * Ceschia, Guido & Schaerf used for INRC-II, 2020). They are costlier than a single-shift move —
 * up to fourteen gate checks — so they take a small, fixed share of the draws.
 *
 * ## Every state the annealer visits is legal per nurse
 *
 * A move is applied only if each nurse it touches passes the rule gate with their new
 * timeline — including a nurse who only *lost* a shift, because a removal can break a rule too
 * (see `SolverModel.isLegal`). Rejected candidates are undone before the next draw. So
 * cancelling mid-run, or hitting the time limit, still leaves a schedule every nurse could
 * legally work.
 */

import type { Assignment, NurseRole } from '../domain/entities.js';
import { blockSwap, type Move, multiDayReassign } from './block-moves.js';
import { greedySeed } from './greedy.js';
import type { AddToken, RemoveToken, Shift, SolverModel } from './model.js';
import type { Rng } from './rng.js';
import type { SolveOptions, SolveProgress } from './types.js';

/** Starting and final temperatures, in objective points. Chosen against the default weights:
 * at 40 points a setback of one night over share (60) is accepted about a fifth of the time
 * and one weekend over share (90) about a tenth; by 0.5 the walk is effectively greedy. */
const START_TEMPERATURE = 40;
const END_TEMPERATURE = 0.5;
/** How often the expensive ruin-and-recreate move runs. */
const LNS_EVERY = 2500;
/** How many adjacent days a ruin clears. */
const LNS_DAYS = 2;
const CANCEL_POLL_EVERY = 64;
/**
 * How often a move aims at something known to be wrong (a shift below its floor, a nurse
 * short of hours) rather than drawing at random. Not always: an undirected draw is what lets
 * the walk rearrange the shifts around a gap, not just the gap itself.
 */
const TARGETED = 0.7;

export interface AnnealResult {
  iterations: number;
  accepted: number;
  improvements: number;
  cancelled: boolean;
  timedOut: boolean;
  best: number;
}

export interface AnnealHooks {
  onProgress?: (progress: Omit<SolveProgress, 'elapsedMs'>) => void;
  shouldStop: () => 'cancelled' | 'timed_out' | null;
}

/**
 * Anneal for iterations `span.from` to `span.to` of an `options.maxIterations` run. The cooling
 * schedule and the ruin-and-recreate cadence follow the iteration number within the whole run,
 * so the hybrid solver can anneal in chunks — handing a few days to CP-SAT between them — and
 * still get one continuous cooling curve rather than a reheat per chunk.
 */
export function anneal(
  model: SolverModel,
  rng: Rng,
  options: SolveOptions,
  hooks: AnnealHooks,
  span?: { from: number; to: number },
): AnnealResult {
  const max = Math.max(0, Math.floor(options.maxIterations));
  const from = Math.max(0, Math.min(max, span?.from ?? 0));
  const to = Math.max(from, Math.min(max, span?.to ?? max));
  const progressEvery = Math.max(1, options.progressEveryIterations ?? 500);

  let current = model.objective();
  let best = current;
  let bestSnapshot = model.snapshot();
  let accepted = 0;
  let improvements = 0;
  let cancelled = false;
  let timedOut = false;
  let it = from;

  for (; it < to; it++) {
    if (it % CANCEL_POLL_EVERY === 0) {
      const stop = hooks.shouldStop();
      if (stop === 'cancelled') cancelled = true;
      if (stop === 'timed_out') timedOut = true;
      if (stop) break;
    }
    if (it % progressEvery === 0) {
      hooks.onProgress?.({
        fraction: it / max,
        phase: 'annealing',
        iteration: it,
        maxIterations: max,
        best,
        current,
        hardShortfall: model.hardShortfall(),
      });
    }

    const temperature = START_TEMPERATURE * (END_TEMPERATURE / START_TEMPERATURE) ** (it / max);
    const move =
      it > 0 && it % LNS_EVERY === 0 ? ruinAndRecreate(model, rng) : randomMove(model, rng);
    if (!move) continue;

    if (move.delta <= 0 || rng.nextFloat() < Math.exp(-move.delta / temperature)) {
      accepted++;
      current += move.delta;
      if (current < best - 1e-9) {
        best = current;
        improvements++;
        bestSnapshot = model.snapshot();
      }
    } else {
      move.undo();
    }
  }

  // Drift guard: the incremental delta bookkeeping and the model's own sums must agree.
  if (Math.abs(model.objective() - current) > 1e-3) {
    throw new Error(
      `Solver objective drifted: tracked ${current}, model ${model.objective()}. ` +
        'A move changed state it did not account for.',
    );
  }

  if (model.objective() > best + 1e-9) model.restore(bestSnapshot);
  return { iterations: it - from, accepted, improvements, cancelled, timedOut, best };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Cumulative draw shares; the block moves take the last tenth (see "Why block moves"). */
function randomMove(model: SolverModel, rng: Rng): Move | null {
  const roll = rng.nextFloat();
  if (roll < 0.27) return reassign(model, rng);
  if (roll < 0.45) return swap(model, rng);
  if (roll < 0.54) return addShift(model, rng);
  if (roll < 0.63) return removeShift(model, rng);
  if (roll < 0.765) return relocate(model, rng);
  if (roll < 0.9) return convert(model, rng);
  if (roll < 0.96) return blockSwap(model, rng);
  return multiDayReassign(model, rng);
}

function pickUnlocked(model: SolverModel, rng: Rng): Assignment | null {
  if (model.unlocked.length === 0) return null;
  return model.unlocked[rng.nextInt(0, model.unlocked.length - 1)] ?? null;
}

function pickIndex(rng: Rng, items: readonly number[]): number | null {
  if (items.length === 0) return null;
  return items[rng.nextInt(0, items.length - 1)] ?? null;
}

/** Hand one shift to a different nurse of the same role. */
function reassign(model: SolverModel, rng: Rng): Move | null {
  const a = pickUnlocked(model, rng);
  if (!a) return null;
  const shift = model.shiftOf(a);
  const from = model.nurseOf(a);
  const role = model.nurses[from]!.role;
  const pool = model.candidates.filter((i) => i !== from && model.eligible(i, shift, role));
  const to = pickIndex(rng, pool);
  if (to === null) return null;

  const before = model.objective();
  const removed = model.remove(a);
  const replacement = model.make(to, shift);
  if (!model.canAdd(to, replacement)) {
    model.undoRemove(a, removed);
    return null;
  }
  const added = model.add(replacement);
  const undo = () => {
    model.undoAdd(replacement, added);
    model.undoRemove(a, removed);
  };
  // The nurse who gave the shift away was never gated: taking it can break a rule too.
  if (!model.isLegal(from)) {
    undo();
    return null;
  }
  return { delta: model.objective() - before, undo };
}

/** Two nurses of the same role trade two shifts. */
function swap(model: SolverModel, rng: Rng): Move | null {
  const a = pickUnlocked(model, rng);
  const b = pickUnlocked(model, rng);
  if (!a || !b || a === b) return null;
  const na = model.nurseOf(a);
  const nb = model.nurseOf(b);
  if (na === nb) return null;
  if (model.nurses[na]!.role !== model.nurses[nb]!.role) return null;
  const sa = model.shiftOf(a);
  const sb = model.shiftOf(b);
  if (sa === sb) return null;

  const before = model.objective();
  const removedA = model.remove(a);
  const removedB = model.remove(b);
  const undoRemovals = () => {
    model.undoRemove(b, removedB);
    model.undoRemove(a, removedA);
  };
  // Eligibility is checked with both shifts out, so "already on that date" sees the
  // post-swap timelines rather than the shifts being traded away.
  if (!model.eligible(nb, sa, null) || !model.eligible(na, sb, null)) {
    undoRemovals();
    return null;
  }
  const aForB = model.make(nb, sa);
  const bForA = model.make(na, sb);
  if (!model.canAdd(nb, aForB) || !model.canAdd(na, bForA)) {
    undoRemovals();
    return null;
  }
  const addedA = model.add(aForB);
  const addedB = model.add(bForA);
  return {
    delta: model.objective() - before,
    undo: () => {
      model.undoAdd(bForA, addedB);
      model.undoAdd(aForB, addedA);
      undoRemovals();
    },
  };
}

/**
 * Put a nurse on a shift. Most of the time the shift is one still below its floor and the
 * nurse is of the role it is short of; the rest of the time both are random, so the walk can
 * also add a surplus shift that repays someone's hours.
 */
function addShift(model: SolverModel, rng: Rng): Move | null {
  if (model.solvableShifts.length === 0) return null;
  let shift: Shift | undefined;
  let role: NurseRole | null = null;
  if (rng.chance(TARGETED)) {
    const short = model.shortShifts();
    shift = short[rng.nextInt(0, Math.max(0, short.length - 1))];
    if (shift) {
      const roles = model.shortRoles(shift);
      role = roles[rng.nextInt(0, Math.max(0, roles.length - 1))] ?? null;
    }
  }
  shift ??= model.solvableShifts[rng.nextInt(0, model.solvableShifts.length - 1)]!;
  const pool = model.candidates.filter((i) => model.eligible(i, shift, role));
  const nurseIdx = pickIndex(rng, pool);
  if (nurseIdx === null) return null;
  const candidate = model.make(nurseIdx, shift);
  if (!model.canAdd(nurseIdx, candidate)) return null;

  const before = model.objective();
  const token: AddToken = model.add(candidate);
  return { delta: model.objective() - before, undo: () => model.undoAdd(candidate, token) };
}

/** Take a random unlocked shift off the schedule. */
function removeShift(model: SolverModel, rng: Rng): Move | null {
  const a = pickUnlocked(model, rng);
  if (!a) return null;
  const before = model.objective();
  const token: RemoveToken = model.remove(a);
  if (!model.isLegal(model.nurseOf(a))) {
    model.undoRemove(a, token);
    return null;
  }
  return { delta: model.objective() - before, undo: () => model.undoRemove(a, token) };
}

/** Move one of a nurse's shifts to another day — how a Friday surplus becomes Saturday cover. */
function relocate(model: SolverModel, rng: Rng): Move | null {
  const a = pickUnlocked(model, rng);
  if (!a) return null;
  const n = model.nurseOf(a);
  const from = model.shiftOf(a);
  let to: Shift | undefined;
  if (rng.chance(TARGETED)) {
    const short = model.shortShifts().filter((s) => s.dateIdx !== from.dateIdx);
    to = short[rng.nextInt(0, Math.max(0, short.length - 1))];
  }
  to ??= model.solvableShifts[rng.nextInt(0, model.solvableShifts.length - 1)];
  if (!to || to.dateIdx === from.dateIdx) return null;

  const before = model.objective();
  const removed = model.remove(a);
  const moved = model.make(n, to);
  if (!model.eligible(n, to, null) || !model.canAdd(n, moved)) {
    model.undoRemove(a, removed);
    return null;
  }
  const added = model.add(moved);
  return {
    delta: model.objective() - before,
    undo: () => {
      model.undoAdd(moved, added);
      model.undoRemove(a, removed);
    },
  };
}

/**
 * Trade one of a nurse's shifts for a different length on the same day, and where that leaves
 * them short, add a second shift of the new length in the same week. This is the move that
 * turns "three 12s" into "two 12s and two 8s": the single steps are each uphill (the first
 * leaves the nurse shorter on hours than before) so the annealer would almost never take
 * them one at a time, but together they are how an 80-hour nurse reaches 80 hours.
 */
function convert(model: SolverModel, rng: Rng): Move | null {
  let a: Assignment | null = null;
  if (rng.chance(TARGETED)) {
    const owed = pickIndex(rng, model.underHoursNurses());
    if (owed !== null) {
      const own = model.timeline(owed).filter((x) => !x.isLocked);
      a = own[rng.nextInt(0, Math.max(0, own.length - 1))] ?? null;
    }
  }
  a ??= pickUnlocked(model, rng);
  if (!a) return null;
  const n = model.nurseOf(a);
  const from = model.shiftOf(a);
  const alternatives = model.solvableShifts.filter(
    (s) =>
      s.dateIdx === from.dateIdx &&
      s !== from &&
      s.shiftType.durationHours !== from.shiftType.durationHours,
  );
  const to = alternatives[rng.nextInt(0, Math.max(0, alternatives.length - 1))];
  if (!to) return null;

  const before = model.objective();
  const removed = model.remove(a);
  const replacement = model.make(n, to);
  if (!model.eligible(n, to, null) || !model.canAdd(n, replacement)) {
    model.undoRemove(a, removed);
    return null;
  }
  const added = model.add(replacement);
  const undo: (() => void)[] = [
    () => {
      model.undoAdd(replacement, added);
      model.undoRemove(a, removed);
    },
  ];

  // Shorter shift: try to make the hours back with a second one of the same type nearby.
  if (to.shiftType.durationHours < from.shiftType.durationHours) {
    const nearby = model.solvableShifts.filter(
      (s) =>
        s.shiftType === to.shiftType &&
        s.dateIdx !== to.dateIdx &&
        Math.abs(s.dateIdx - to.dateIdx) <= 6 &&
        model.eligible(n, s, null),
    );
    const extraShift = nearby[rng.nextInt(0, Math.max(0, nearby.length - 1))];
    if (extraShift) {
      const extra = model.make(n, extraShift);
      if (model.canAdd(n, extra)) {
        const token = model.add(extra);
        undo.unshift(() => model.undoAdd(extra, token));
      }
    }
  }

  return {
    delta: model.objective() - before,
    undo: () => {
      for (const step of undo) step();
    },
  };
}

/** Clear a few adjacent days and rebuild them with the greedy passes. */
function ruinAndRecreate(model: SolverModel, rng: Rng): Move | null {
  if (model.dates.length === 0) return null;
  const start = rng.nextInt(0, Math.max(0, model.dates.length - LNS_DAYS));
  const dateIdxs = new Set<number>();
  for (let d = start; d < Math.min(model.dates.length, start + LNS_DAYS); d++) dateIdxs.add(d);

  const before = model.objective();
  const removed = model.unlocked.filter((a) => dateIdxs.has(model.shiftOf(a).dateIdx));
  for (const a of removed) model.remove(a);
  const added = greedySeed(model, dateIdxs);
  const undo = () => {
    for (let i = added.length - 1; i >= 0; i--) model.remove(added[i]!);
    // Re-adding what was there restores each nurse's previous set of shifts, which the
    // gate already passed, so no re-check is needed.
    for (const a of removed) model.add(a);
  };
  // Everyone who lost a shift and was not given one back by the greedy passes (which gate each
  // addition) is unchecked — and a removal can break a rule.
  const regated = new Set(added.map((a) => model.nurseOf(a)));
  for (const n of new Set(removed.map((a) => model.nurseOf(a)))) {
    if (!regated.has(n) && !model.isLegal(n)) {
      undo();
      return null;
    }
  }
  return { delta: model.objective() - before, undo };
}
