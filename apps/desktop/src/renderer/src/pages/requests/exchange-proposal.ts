/**
 * Pure helpers for the exchange dialogs: turning form state into the `ExchangeProposal` core
 * judges, and labelling an assignment option so a manager can tell two Tuesday nights apart.
 * Kept out of the dialog component so they can be unit tested without mounting React.
 */

import type { Assignment, ExchangeProposal, Id, ShiftSwapKind, ShiftType } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';

export interface ExchangeFormState {
  kind: ShiftSwapKind;
  requestingNurseId: string;
  counterpartyNurseId: string;
  offeredAssignmentId: string;
  /** Ignored for a giveaway — a trade with nothing offered back is still a trade in form state
   * until it validates, so the kind alone decides whether this field matters. */
  requestedAssignmentId: string;
}

/**
 * `undefined` when the form is not yet complete enough for core to judge: a trade needs both
 * sides named and both assignments picked; a giveaway only needs the offered side, and any
 * requested-assignment selection left over from switching kinds is dropped rather than sent.
 */
export function buildExchangeProposal(form: ExchangeFormState): ExchangeProposal | undefined {
  if (!form.requestingNurseId || !form.counterpartyNurseId || !form.offeredAssignmentId) {
    return undefined;
  }
  if (form.requestingNurseId === form.counterpartyNurseId) return undefined;
  if (form.kind === 'giveaway') {
    return {
      kind: 'giveaway',
      requestingNurseId: form.requestingNurseId as Id,
      counterpartyNurseId: form.counterpartyNurseId as Id,
      offeredAssignmentId: form.offeredAssignmentId as Id,
    };
  }
  if (!form.requestedAssignmentId) return undefined;
  return {
    kind: 'trade',
    requestingNurseId: form.requestingNurseId as Id,
    counterpartyNurseId: form.counterpartyNurseId as Id,
    offeredAssignmentId: form.offeredAssignmentId as Id,
    requestedAssignmentId: form.requestedAssignmentId as Id,
  };
}

/** "Fri 2026-01-16 · N12 (charge)" — enough to tell two shifts on the same grid apart. */
export function assignmentOptionLabel(
  assignment: Assignment,
  shiftTypesById: ReadonlyMap<Id, ShiftType>,
): string {
  const shiftType = shiftTypesById.get(assignment.shiftTypeId);
  const name = shiftType?.abbreviation ?? shiftType?.name ?? assignment.shiftTypeId;
  return `${formatDateWithWeekday(assignment.date)} · ${name}${assignment.isCharge ? ' (charge)' : ''}`;
}
