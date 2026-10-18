/**
 * What census cancellation and float rotation share: how a nurse is named in a refusal, and the
 * one rule that only the nurse at the top of a contract order may be acted on. Written once so
 * the two screens cannot drift apart on who counts as "first".
 */

import type { Id, Nurse } from '@shiftnurse/core';

export const nurseName = (n: Pick<Nurse, 'firstName' | 'lastName'>) =>
  `${n.firstName} ${n.lastName}`;

interface Place {
  nurseId: Id;
  name: string;
  reason: string;
}

/** The place `nurseId` holds, or the refusal a manager can act on (worded by the caller). */
export function firstInOrder<P extends Place>(
  view: { order: readonly P[]; excluded: readonly Place[] },
  nurseId: Id,
  words: { excluded: (e: Place) => string; notFirst: (first: P, mine: P) => string },
): P {
  const excluded = view.excluded.find((e) => e.nurseId === nurseId);
  if (excluded) throw new Error(words.excluded(excluded));
  const first = view.order[0];
  const mine = view.order.find((p) => p.nurseId === nurseId);
  if (!mine) throw new Error('That nurse is not on this shift.');
  if (first && first.nurseId !== nurseId) throw new Error(words.notFirst(first, mine));
  return mine;
}
