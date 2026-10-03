/**
 * The per-assignment editor: opened by clicking (or pressing Enter on) a chip. Lock/charge/
 * overtime are booleans a manager flips constantly while building a schedule, so each is one
 * click rather than a full edit form; Remove is destructive so it still gets a confirm. "Move
 * to" is the keyboard route for what dragging a chip does: the same move, through the same
 * handler (and so the same reason prompt on a published schedule).
 *
 * It also answers what a manager asks before touching a shift — how many hours this nurse has
 * in the pay period, and who else is on — and offers the two edits they make most: change the
 * shift type in place (days to nights) and swap with someone working that day.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Assignment, Id, IsoDate, Nurse, ShiftType, Violation } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useConfirm } from '../../components/confirm.js';
import { INPUT, LABEL, OVERLAY, SECONDARY } from '../../components/ui.js';
import { formatDateWithWeekday, listName } from '../../format.js';
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
  /** What the manager wants to know about this shift before changing it. */
  context?: {
    hoursThisPayPeriod: number;
    contractedHours: number;
    payPeriodLabel: string;
    alsoOnShift: readonly Nurse[];
  };
  /** Every active shift type, for "change to". */
  shiftTypes: readonly ShiftType[];
  /** Other nurses' shifts on the same date, for "swap with". */
  swapOptions: readonly { assignment: Assignment; nurse: Nurse; shiftType: ShiftType }[];
  onSwap: (firstId: Id, secondId: Id) => void;
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
  context,
  shiftTypes,
  swapOptions,
  onSwap,
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
          className="fixed z-50 left-1/2 top-1/2 max-h-[calc(100vh-2rem)] w-[26rem] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg
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
              {context ? (
                <div className="mt-2 flex flex-col gap-1 text-xs text-text-muted">
                  <p data-testid="assignment-hours">
                    {context.contractedHours > 0
                      ? `${context.hoursThisPayPeriod}h of ${context.contractedHours}h`
                      : `${context.hoursThisPayPeriod}h`}{' '}
                    scheduled in the pay period {context.payPeriodLabel}
                  </p>
                  <p>
                    {context.alsoOnShift.length === 0
                      ? 'Nobody else on this shift yet.'
                      : `Also on: ${context.alsoOnShift
                          .slice(0, 8)
                          .map((n) => listName(n))
                          .join(
                            '; ',
                          )}${context.alsoOnShift.length > 8 ? ` and ${context.alsoOnShift.length - 8} more` : ''}`}
                  </p>
                </div>
              ) : null}

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

              <ChangeSection
                assignment={assignment}
                shiftTypes={shiftTypes}
                swapOptions={swapOptions}
                disabled={pending}
                onChangeType={(shiftTypeId) => {
                  onClose();
                  onMove({
                    assignmentId: assignment.id,
                    nurseId: assignment.nurseId,
                    shiftTypeId,
                    date: assignment.date,
                  });
                }}
                onSwap={(otherId) => {
                  onClose();
                  onSwap(assignment.id, otherId);
                }}
              />

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
                  <button type="button" className={SECONDARY}>
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
              {listName(n)} ({n.role})
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

function ChangeSection({
  assignment,
  shiftTypes,
  swapOptions,
  disabled,
  onChangeType,
  onSwap,
}: {
  assignment: Assignment;
  shiftTypes: readonly ShiftType[];
  swapOptions: AssignmentDialogProps['swapOptions'];
  disabled: boolean;
  onChangeType: (shiftTypeId: Id) => void;
  onSwap: (otherId: Id) => void;
}) {
  const others = shiftTypes.filter((st) => st.active && st.id !== assignment.shiftTypeId);
  const [shiftTypeId, setShiftTypeId] = useState<Id | ''>('');
  const [swapId, setSwapId] = useState<Id | ''>('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the choices when another shift opens.
  useEffect(() => {
    setShiftTypeId('');
    setSwapId('');
  }, [assignment.id]);
  if (assignment.isLocked) return null;
  return (
    <fieldset className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      <legend className="pt-3 text-xs font-medium text-text-muted">Change this shift</legend>
      {others.length > 0 ? (
        <div className="flex items-end gap-2">
          <label className={`${LABEL} flex-1`}>
            Change to
            <select
              className={INPUT}
              data-testid="assignment-change-type"
              value={shiftTypeId}
              onChange={(e) => setShiftTypeId(e.target.value)}
            >
              <option value="">Choose a shift…</option>
              {others.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.abbreviation} — {st.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={SECONDARY}
            disabled={disabled || shiftTypeId === ''}
            onClick={() => shiftTypeId !== '' && onChangeType(shiftTypeId)}
          >
            Change
          </button>
        </div>
      ) : null}
      {swapOptions.length > 0 ? (
        <div className="flex items-end gap-2">
          <label className={`${LABEL} flex-1`}>
            Swap with
            <select
              className={INPUT}
              data-testid="assignment-swap-with"
              value={swapId}
              onChange={(e) => setSwapId(e.target.value)}
            >
              <option value="">Choose a nurse on that day…</option>
              {swapOptions.map((o) => (
                <option key={o.assignment.id} value={o.assignment.id}>
                  {listName(o.nurse)} — {o.shiftType.abbreviation}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={SECONDARY}
            disabled={disabled || swapId === ''}
            onClick={() => swapId !== '' && onSwap(swapId)}
          >
            Swap
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}
