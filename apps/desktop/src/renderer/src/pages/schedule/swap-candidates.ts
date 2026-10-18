/**
 * Which shifts the popover may offer to swap with. An unsaved Generate/drag preview shift
 * (`pending-…` id) is not on the server: picking one sent a client id to `swapAssignments` and
 * main answered "not found".
 */

import type { Assignment } from '@shiftnurse/core';
import { isPendingId } from './grid-utils.js';

export function swapCandidates(all: readonly Assignment[], open: Assignment): Assignment[] {
  return all.filter(
    (a) =>
      a.date === open.date &&
      a.nurseId !== open.nurseId &&
      a.shiftTypeId !== open.shiftTypeId &&
      !a.isLocked &&
      !isPendingId(a.id),
  );
}
