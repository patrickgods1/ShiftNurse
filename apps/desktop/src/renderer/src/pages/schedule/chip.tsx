/**
 * One assignment on the grid. A `<button>` (not a `<div>`) so it is keyboard-focusable and
 * `Enter` opens the edit popover for free; `Delete`/`Backspace` remove it (with confirm) without
 * needing the mouse. Locked assignments render but refuse to start a drag — the solver already
 * enforces this server-side (`moveAssignment` throws on a locked source), this just keeps the
 * manager from dragging something that will bounce.
 */

import type { Assignment, ShiftType, Violation } from '@shiftnurse/core';
import { memo } from 'react';
import { readableTextColor } from './colors.js';
import { setDragPayload } from './dnd.js';
import { chipHeightClass, chipWidthClass, isPendingId } from './grid-utils.js';

interface AssignmentChipProps {
  assignment: Assignment;
  shiftType: ShiftType | undefined;
  violations: readonly Violation[];
  readOnly: boolean;
  pending: boolean;
  onOpen: (assignment: Assignment) => void;
  onDelete: (assignment: Assignment) => void;
  /** In the grid's active cell: only then is the chip a tab stop (see `grid.tsx`). */
  tabbable?: boolean;
}

export const AssignmentChip = memo(function AssignmentChip({
  assignment,
  shiftType,
  violations,
  readOnly,
  pending,
  onOpen,
  onDelete,
  tabbable = true,
}: AssignmentChipProps) {
  const optimistic = pending || isPendingId(assignment.id);
  const interactive = !readOnly && !optimistic;
  const draggable = interactive && !assignment.isLocked;
  const hard = violations.some((v) => v.severity === 'hard');
  const soft = !hard && violations.length > 0;

  const color = shiftType?.color ?? '#9aa2b1';
  const titleParts: string[] = [];
  if (assignment.isLocked) titleParts.push('Locked');
  if (violations.length > 0) titleParts.push(...violations.map((v) => v.message));
  const title =
    titleParts.length > 0
      ? titleParts.join('\n')
      : (shiftType?.name ?? 'Shift') + (assignment.isCharge ? ' · charge' : '');

  return (
    <button
      type="button"
      data-testid="assignment-chip"
      tabIndex={tabbable ? 0 : -1}
      draggable={draggable}
      disabled={optimistic}
      title={title}
      aria-label={`${shiftType?.abbreviation ?? 'Shift'} on ${assignment.date}${
        assignment.isLocked ? ', locked' : ''
      }${assignment.isCharge ? ', charge nurse' : ''}${hard ? ', hard violation' : soft ? ', soft violation' : ''}`}
      onDragStart={(event) => {
        if (!draggable) {
          event.preventDefault();
          return;
        }
        setDragPayload(event, {
          kind: 'move',
          assignmentId: assignment.id,
          shiftTypeId: assignment.shiftTypeId,
        });
      }}
      onClick={() => {
        if (interactive) onOpen(assignment);
      }}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          onDelete(assignment);
        }
      }}
      className={`relative mb-1 flex items-center justify-center rounded px-1 text-[11px]
        font-semibold leading-none last:mb-0 ${chipWidthClass(shiftType?.durationHours ?? 12)} ${chipHeightClass(
          shiftType?.durationHours ?? 12,
        )} ${draggable ? 'cursor-grab active:cursor-grabbing' : assignment.isLocked ? 'cursor-not-allowed' : ''} ${
          optimistic ? 'opacity-50' : ''
        } ${hard ? 'ring-2 ring-danger' : soft ? 'ring-2 ring-warn' : ''} ${
          !readOnly ? 'focus-visible:ring-2 focus-visible:ring-accent' : ''
        }`}
      style={{ backgroundColor: color, color: readableTextColor(color) }}
    >
      <span className="truncate">{shiftType?.abbreviation ?? '?'}</span>
      {assignment.isLocked ? <span className="ml-0.5">🔒</span> : null}
      {assignment.isCharge ? (
        <span className="absolute -bottom-1 -right-1 rounded-full bg-surface px-1 text-[9px] font-bold text-text">
          C
        </span>
      ) : null}
      {hard || soft ? (
        <span
          className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${
            hard ? 'bg-danger' : 'bg-warn'
          }`}
        />
      ) : null}
    </button>
  );
});
