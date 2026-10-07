/**
 * One assignment on the grid. A `<button>` (not a `<div>`) so it is keyboard-focusable and
 * `Enter` opens the edit popover for free; `Delete`/`Backspace` remove it (with confirm) without
 * needing the mouse. Locked assignments render but refuse to start a drag — the solver already
 * enforces this server-side (`moveAssignment` throws on a locked source), this just keeps the
 * manager from dragging something that will bounce.
 */

import type { Assignment, ShiftType, Violation } from '@shiftnurse/core';
import { memo } from 'react';
import { formatHoldover } from '../../format.js';
import { readableTextColor } from './colors.js';
import { setDragPayload } from './dnd.js';
import { chipHeightClass, chipWidthClass, isPendingId } from './grid-utils.js';

interface AssignmentChipProps {
  assignment: Assignment;
  shiftType: ShiftType | undefined;
  violations: readonly Violation[];
  readOnly: boolean;
  pending: boolean;
  /** Differs from the draft, in a preview of a Generate variation. */
  highlighted?: boolean;
  onOpen: (assignment: Assignment) => void;
  onDelete: (assignment: Assignment) => void;
  /** In the grid's active cell: only then is the chip a tab stop (see `grid.tsx`). */
  tabbable?: boolean;
  /** "Goes against Tyler Clark's request: avoids Night 12 (strong)", when it does. */
  preferenceNote?: string | undefined;
  /** One of the shifts a "Show on grid" link is about. */
  spotlit?: boolean;
}

export const AssignmentChip = memo(function AssignmentChip({
  assignment,
  shiftType,
  violations,
  readOnly,
  pending,
  highlighted = false,
  onOpen,
  onDelete,
  tabbable = true,
  preferenceNote,
  spotlit = false,
}: AssignmentChipProps) {
  const optimistic = pending || isPendingId(assignment.id);
  const interactive = !readOnly && !optimistic;
  const draggable = interactive && !assignment.isLocked;
  const hard = violations.some((v) => v.severity === 'hard');
  const soft = !hard && violations.length > 0;

  const color = shiftType?.color ?? '#9aa2b1';
  const titleParts: string[] = [];
  if (assignment.isLocked) titleParts.push('Locked');
  if (highlighted) titleParts.push('Differs from the draft');
  if (violations.length > 0) titleParts.push(...violations.map((v) => v.message));
  if (preferenceNote) titleParts.push(preferenceNote);
  const held = assignment.holdoverMinutes ?? 0;
  const heldNote =
    held > 0
      ? `Held over ${formatHoldover(held)} (${assignment.holdoverMandated ? 'required' : 'volunteered'})`
      : undefined;
  if (heldNote) titleParts.push(heldNote);
  const title =
    titleParts.length > 0
      ? titleParts.join('\n')
      : (shiftType?.name ?? 'Shift') + (assignment.isCharge ? ' · charge' : '');

  return (
    <button
      type="button"
      data-testid="assignment-chip"
      data-spotlit={spotlit ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable={draggable}
      disabled={optimistic}
      title={title}
      aria-label={`${shiftType?.abbreviation ?? 'Shift'} on ${assignment.date}${
        assignment.isLocked ? ', locked' : ''
      }${assignment.isCharge ? ', charge nurse' : ''}${hard ? ', hard violation' : soft ? ', soft violation' : ''}${
        highlighted ? ', differs from the draft' : ''
      }${preferenceNote ? ', against a stated preference' : ''}${
        heldNote ? `, ${heldNote.toLowerCase()}` : ''
      }`}
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
      className={`relative mb-1 flex items-center justify-center rounded px-1 text-xs
        font-semibold leading-none last:mb-0 ${chipWidthClass(shiftType?.durationHours ?? 12)} ${chipHeightClass(
          shiftType?.durationHours ?? 12,
        )} ${draggable ? 'cursor-grab active:cursor-grabbing' : assignment.isLocked ? 'cursor-not-allowed' : ''} ${
          optimistic ? 'opacity-50' : ''
        } ${hard ? 'border-2 border-solid border-danger' : soft ? 'border-2 border-dashed border-warn' : ''} ${
          highlighted ? 'outline outline-2 outline-offset-1 outline-accent' : ''
        } ${spotlit ? 'outline outline-2 outline-offset-2 outline-danger' : ''} ${!readOnly ? 'focus-visible:ring-2 focus-visible:ring-accent' : ''}`}
      style={{ backgroundColor: color, color: readableTextColor(color) }}
    >
      <span className="truncate">{shiftType?.abbreviation ?? '?'}</span>
      {assignment.isLocked ? <span className="ml-0.5">🔒</span> : null}
      {assignment.isCharge ? (
        <span className="absolute -bottom-1 -right-1 rounded-full bg-surface px-1 text-xs font-bold text-text">
          C
        </span>
      ) : null}
      {preferenceNote ? (
        <span
          aria-hidden
          className="absolute -left-1 -top-1 rounded-full bg-surface px-0.5 text-xs leading-none text-warn"
        >
          ♡
        </span>
      ) : null}
      {held > 0 ? (
        <span
          data-testid="holdover-mark"
          className="absolute -bottom-1 -left-1 rounded-full bg-surface px-1 text-[10px] font-bold leading-tight text-text"
        >
          +{formatHoldover(held).replace(' ', '')}
        </span>
      ) : null}
      {hard || soft ? <SeverityMark severity={hard ? 'hard' : 'soft'} /> : null}
    </button>
  );
});

/**
 * Hard (solid border) and soft (dashed) differ by outline shape as well as colour (octagon = stop, triangle = caution),
 * so a manager who cannot tell red from amber still can tell a breach from an advisory.
 */
export function SeverityMark({ severity }: { severity: 'hard' | 'soft' }) {
  const hard = severity === 'hard';
  return (
    <svg
      aria-hidden
      data-severity={severity}
      viewBox="0 0 10 10"
      className={`absolute -right-1 -top-1 h-3 w-3 ${hard ? 'text-danger' : 'text-warn'}`}
    >
      <polygon
        points={hard ? '3,0.5 7,0.5 9.5,3 9.5,7 7,9.5 3,9.5 0.5,7 0.5,3' : '5,0.5 9.8,9.5 0.2,9.5'}
        fill="currentColor"
        stroke="var(--color-surface, white)"
        strokeWidth="0.8"
      />
    </svg>
  );
}
