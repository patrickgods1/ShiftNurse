/**
 * The per-assignment editor: opened by clicking (or pressing Enter on) a chip. Lock/charge/
 * overtime are booleans a manager flips constantly while building a schedule, so each is one
 * click rather than a full edit form; Remove is destructive so it still gets a confirm. "Move
 * to" is the keyboard route for what dragging a chip does: the same move, through the same
 * handler (and so the same reason prompt on a published schedule).
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Assignment, Id, IsoDate, Nurse, ShiftType, Violation } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useConfirm } from '../../components/confirm.js';
import { INPUT, LABEL, OVERLAY, SECONDARY } from '../../components/ui.js';
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
  /** Rows of the grid, in grid order: who the shift can move to. */
  nurses: readonly Nurse[];
  /** The period's dates: where the shift can move to. */
  dates: readonly IsoDate[];
  onMove: (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => void;
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
  nurses,
  dates,
  onMove,
}: AssignmentDialogProps) {
  const confirm = useConfirm();
  const open = assignment !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
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
                  onClick={async () => {
                    if (
                      await confirm({ title: 'Remove this assignment?', confirmLabel: 'Remove' })
                    ) {
                      onRemove(assignment);
                    }
                  }}
                  className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger
                    hover:bg-danger/10 disabled:opacity-60"
                >
                  Remove
                </button>
              </div>

              <MoveSection
                assignment={assignment}
                nurses={nurses}
                dates={dates}
                disabled={pending}
                onMove={(input) => {
                  onClose();
                  onMove(input);
                }}
              />

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

function MoveSection({
  assignment,
  nurses,
  dates,
  disabled,
  onMove,
}: {
  assignment: Assignment;
  nurses: readonly Nurse[];
  dates: readonly IsoDate[];
  disabled: boolean;
  onMove: AssignmentDialogProps['onMove'];
}) {
  const [nurseId, setNurseId] = useState<Id>(assignment.nurseId);
  const [date, setDate] = useState<IsoDate>(assignment.date);
  useEffect(() => {
    setNurseId(assignment.nurseId);
    setDate(assignment.date);
  }, [assignment.nurseId, assignment.date]);

  const unchanged = nurseId === assignment.nurseId && date === assignment.date;
  return (
    <fieldset className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      <legend className="pt-3 text-xs font-medium text-text-muted">Move to</legend>
      <label className={LABEL}>
        Nurse
        <select
          className={INPUT}
          value={nurseId}
          onChange={(e) => setNurseId(e.target.value)}
          disabled={assignment.isLocked}
        >
          {nurses.map((n) => (
            <option key={n.id} value={n.id}>
              {n.lastName}, {n.firstName} ({n.role})
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Date
        <select
          className={INPUT}
          value={date}
          onChange={(e) => setDate(e.target.value as IsoDate)}
          disabled={assignment.isLocked}
        >
          {dates.map((d) => (
            <option key={d} value={d}>
              {formatDateWithWeekday(d)}
            </option>
          ))}
        </select>
      </label>
      {assignment.isLocked ? (
        <p className="text-xs text-text-muted">Unlock the shift to move it.</p>
      ) : null}
      <button
        type="button"
        data-testid="assignment-move"
        className={SECONDARY}
        disabled={disabled || assignment.isLocked || unchanged}
        onClick={() =>
          onMove({
            assignmentId: assignment.id,
            nurseId,
            shiftTypeId: assignment.shiftTypeId,
            date,
          })
        }
      >
        Move
      </button>
    </fieldset>
  );
}
