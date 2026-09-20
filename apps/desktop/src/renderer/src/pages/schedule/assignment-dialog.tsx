/**
 * The per-assignment editor: opened by clicking (or pressing Enter on) a chip. Lock/charge/
 * overtime are booleans a manager flips constantly while building a schedule, so each is one
 * click rather than a full edit form; Remove is destructive so it still gets a confirm.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Assignment, Nurse, ShiftType, Violation } from '@shiftnurse/core';
import { formatDateWithWeekday } from '../../format.js';
import { violationKey } from './grid-utils.js';

interface AssignmentDialogProps {
  assignment: Assignment | undefined;
  nurse: Nurse | undefined;
  shiftType: ShiftType | undefined;
  violations: readonly Violation[];
  pending: boolean;
  onClose: () => void;
  onToggleLock: (assignment: Assignment) => void;
  onToggleCharge: (assignment: Assignment) => void;
  onToggleOvertime: (assignment: Assignment) => void;
  onRemove: (assignment: Assignment) => void;
}

export function AssignmentDialog({
  assignment,
  nurse,
  shiftType,
  violations,
  pending,
  onClose,
  onToggleLock,
  onToggleCharge,
  onToggleOvertime,
  onRemove,
}: AssignmentDialogProps) {
  const open = assignment !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg
            border border-border bg-surface p-5 shadow-lg"
        >
          {assignment !== undefined ? (
            <>
              <Dialog.Title className="text-base font-semibold text-text">
                {shiftType?.name ?? 'Shift'}
                {nurse !== undefined ? ` — ${nurse.firstName} ${nurse.lastName}` : ''}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {formatDateWithWeekday(assignment.date)}
              </Dialog.Description>

              {violations.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 rounded-md border border-border p-2">
                  {violations.map((violation) => (
                    <li
                      key={violationKey(violation)}
                      className={`text-xs ${
                        violation.severity === 'hard' ? 'text-danger' : 'text-warn'
                      }`}
                    >
                      {violation.message}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  data-testid="assignment-toggle-lock"
                  disabled={pending}
                  onClick={() => onToggleLock(assignment)}
                  className={secondaryBtn}
                >
                  {assignment.isLocked ? 'Unlock' : 'Lock'}
                </button>
                <button
                  type="button"
                  data-testid="assignment-toggle-charge"
                  disabled={pending}
                  onClick={() => onToggleCharge(assignment)}
                  className={secondaryBtn}
                >
                  {assignment.isCharge ? 'Remove charge nurse' : 'Mark charge nurse'}
                </button>
                <button
                  type="button"
                  data-testid="assignment-toggle-overtime"
                  disabled={pending}
                  onClick={() => onToggleOvertime(assignment)}
                  className={secondaryBtn}
                >
                  {assignment.isOvertime ? 'Remove overtime authorisation' : 'Authorise overtime'}
                </button>
                <button
                  type="button"
                  data-testid="assignment-remove"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm('Remove this assignment?')) onRemove(assignment);
                  }}
                  className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger
                    hover:bg-danger/10 disabled:opacity-60"
                >
                  Remove
                </button>
              </div>

              <div className="mt-4 flex justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                  >
                    Close
                  </button>
                </Dialog.Close>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const secondaryBtn =
  'rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-60';
