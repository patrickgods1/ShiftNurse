/**
 * Block moves: trade, or hand over, every unlocked shift two nurses hold across a run of days.
 *
 * ## Why moves bigger than one shift
 *
 * The single-shift moves in `anneal.ts` cannot cross a rest-rule wall. A nurse who wants nights
 * but holds Monday–Wednesday days, and a colleague who wants days but holds the matching nights,
 * cannot trade any one of those days: a night ending 07:00 followed by a day starting 07:00 is
 * zero hours of rest, so every intermediate state is illegal and the gate refuses it. Trading
 * the whole run at once jumps straight to the legal schedule on the other side. Ceschia, Guido
 * & Schaerf (Ann. Oper. Res. 288, 2020) got their INRC-II results from exactly this
 * neighbourhood — swapping blocks of consecutive days between two compatible nurses — driven by
 * simulated annealing like ours.
 *
 * ## All or nothing
 *
 * Every shift in the block is removed first, then placed on its new owner one by one through
 * the same eligibility check and rule gate as any other move. If any placement fails, every
 * step is undone in reverse, so a refused block move leaves the model exactly as it found it
 * and an accepted one never leaves either nurse with an illegal timeline. Locked shifts are
 * never part of a block; they stay where the manager pinned them and the gate judges the rest
 * of the block around them.
 */

import type { Assignment } from '../domain/entities.js';
import type { Shift, SolverModel } from './model.js';
import type { Rng } from './rng.js';

export interface Move {
  delta: number;
  undo: () => void;
}

/** 'swap' trades both nurses' blocks; 'give' moves `from`'s block to `to` and takes nothing back. */
export type BlockMode = 'swap' | 'give';

const MIN_BLOCK_DAYS = 2;
const MAX_BLOCK_DAYS = 7;

/**
 * Move every unlocked shift `from` holds on days `first..last` (date indexes, inclusive) to
 * `to`, and in 'swap' mode `to`'s unlocked shifts on those days back to `from`. Returns null,
 * with the model untouched, if there is nothing to move or any resulting timeline is illegal.
 */
export function exchangeBlock(
  model: SolverModel,
  from: number,
  to: number,
  first: number,
  last: number,
  mode: BlockMode,
): Move | null {
  if (from === to) return null;
  if (model.nurses[from]!.role !== model.nurses[to]!.role) return null;
  const inBlock = (a: Assignment): boolean => {
    const d = model.shiftOf(a).dateIdx;
    return !a.isLocked && d >= first && d <= last;
  };
  const outgoing = model.timeline(from).filter(inBlock);
  const incoming = mode === 'swap' ? model.timeline(to).filter(inBlock) : [];
  if (outgoing.length === 0 && incoming.length === 0) return null;

  const before = model.objective();
  const undo: (() => void)[] = [];
  const rollback = () => {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
  };

  for (const a of [...outgoing, ...incoming]) {
    const token = model.remove(a);
    undo.push(() => model.undoRemove(a, token));
  }
  const place = (nurse: number, shifts: readonly Shift[]): boolean => {
    for (const shift of shifts) {
      if (!model.eligible(nurse, shift, null)) return false;
      const candidate = model.make(nurse, shift);
      if (!model.canAdd(nurse, candidate)) return false;
      const token = model.add(candidate);
      undo.push(() => model.undoAdd(candidate, token));
    }
    return true;
  };
  if (
    !place(
      to,
      outgoing.map((a) => model.shiftOf(a)),
    ) ||
    !place(
      from,
      incoming.map((a) => model.shiftOf(a)),
    )
  ) {
    rollback();
    return null;
  }
  return { delta: model.objective() - before, undo: rollback };
}

/** Two same-role nurses trade everything they hold across 2–7 consecutive days. */
export function blockSwap(model: SolverModel, rng: Rng): Move | null {
  const block = pickBlock(model, rng);
  if (!block) return null;
  // Only a nurse who may receive new shifts can take the other half of a trade.
  if (!model.candidates.includes(block.from)) return null;
  return exchangeBlock(model, block.from, block.to, block.first, block.last, 'swap');
}

/** One nurse's 2–7 day run of shifts goes to a same-role colleague. */
export function multiDayReassign(model: SolverModel, rng: Rng): Move | null {
  const block = pickBlock(model, rng);
  if (!block) return null;
  return exchangeBlock(model, block.from, block.to, block.first, block.last, 'give');
}

/** A block anchored on a random unlocked shift, so blocks land where there is work to move. */
function pickBlock(
  model: SolverModel,
  rng: Rng,
): { from: number; to: number; first: number; last: number } | null {
  if (model.unlocked.length === 0 || model.dates.length === 0) return null;
  const anchor = model.unlocked[rng.nextInt(0, model.unlocked.length - 1)]!;
  const from = model.nurseOf(anchor);
  const role = model.nurses[from]!.role;
  const pool = model.candidates.filter((i) => i !== from && model.nurses[i]!.role === role);
  if (pool.length === 0) return null;
  const to = pool[rng.nextInt(0, pool.length - 1)]!;
  const length = rng.nextInt(MIN_BLOCK_DAYS, MAX_BLOCK_DAYS);
  const day = model.shiftOf(anchor).dateIdx;
  const first = Math.max(0, day - rng.nextInt(0, length - 1));
  const last = Math.min(model.dates.length - 1, first + length - 1);
  return { from, to, first, last };
}
