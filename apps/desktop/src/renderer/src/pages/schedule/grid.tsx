/**
 * The nurse x day grid. Rows are memoised (`React.memo` + stable callbacks from the parent) so
 * that redrawing 42 nurses x 42 days on every validation refresh doesn't mean re-rendering
 * every cell that didn't change — only the row(s) whose props actually differ do. That only
 * holds if per-row props are per-row: a row sees the drag highlight only when it is in that
 * row, and the pending set only when one of its own shifts is pending. Violation
 * indexes are built once per validation result by the caller (`board.tsx`) and passed in as
 * plain maps, so this component never re-walks the violations array itself.
 */

import type { Assignment, Id, IsoDate, Nurse, ShiftType, Violation } from '@shiftnurse/core';
import { memo, useCallback, useMemo, useState } from 'react';
import { AssignmentChip } from './chip.js';
import type { DragPayload } from './dnd.js';
import { readDragPayload } from './dnd.js';
import { buildCellIndex, cellKey, SHORT_WEEKDAY, sortNurses } from './grid-utils.js';

export interface GridColumn {
  date: IsoDate;
  weekday: number;
  isWeekend: boolean;
}

const EMPTY_VIOLATIONS: readonly Violation[] = [];

function severityCounts(violations: readonly Violation[] | undefined): {
  hard: number;
  soft: number;
} {
  if (!violations || violations.length === 0) return { hard: 0, soft: 0 };
  let hard = 0;
  for (const v of violations) if (v.severity === 'hard') hard += 1;
  return { hard, soft: violations.length - hard };
}

function CountBadge({ hard, soft, title }: { hard: number; soft: number; title: string }) {
  if (hard === 0 && soft === 0) return null;
  return (
    <span
      title={title}
      className={`ml-1 inline-flex min-w-[1rem] items-center justify-center rounded-full px-1
        text-[10px] font-semibold ${hard > 0 ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'}`}
    >
      {hard > 0 ? hard : soft}
    </span>
  );
}

interface GridCellProps {
  nurseId: Id;
  date: IsoDate;
  assignments: readonly Assignment[];
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  violationsByAssignment: ReadonlyMap<Id, Violation[]>;
  pendingIds: ReadonlySet<Id>;
  isDragOver: boolean;
  isWeekend: boolean;
  readOnly: boolean;
  onDrop: (payload: DragPayload) => void;
  onDragOverChange: (over: boolean) => void;
  onChipOpen: (assignment: Assignment) => void;
  onChipDelete: (assignment: Assignment) => void;
}

function GridCell({
  assignments,
  shiftTypesById,
  violationsByAssignment,
  pendingIds,
  isDragOver,
  isWeekend,
  readOnly,
  onDrop,
  onDragOverChange,
  onChipOpen,
  onChipDelete,
}: GridCellProps) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: native HTML5 DnD only; the keyboard path is the chip's own popover (Enter) and Delete key, not this drop target.
    <div
      className={`flex h-14 w-16 shrink-0 flex-col items-center justify-center border-b border-r
        border-border px-0.5 ${isWeekend ? 'bg-bg' : 'bg-surface'} ${
          isDragOver ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
        }`}
      onDragEnter={
        readOnly
          ? undefined
          : (event) => {
              event.preventDefault();
              onDragOverChange(true);
            }
      }
      onDragOver={
        readOnly
          ? undefined
          : (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }
      }
      onDragLeave={
        readOnly
          ? undefined
          : (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                onDragOverChange(false);
              }
            }
      }
      onDrop={
        readOnly
          ? undefined
          : (event) => {
              event.preventDefault();
              onDragOverChange(false);
              const payload = readDragPayload(event);
              if (payload) onDrop(payload);
            }
      }
    >
      {assignments.map((assignment) => (
        <AssignmentChip
          key={assignment.id}
          assignment={assignment}
          shiftType={shiftTypesById.get(assignment.shiftTypeId)}
          violations={violationsByAssignment.get(assignment.id) ?? EMPTY_VIOLATIONS}
          readOnly={readOnly}
          pending={pendingIds.has(assignment.id)}
          onOpen={onChipOpen}
          onDelete={onChipDelete}
        />
      ))}
    </div>
  );
}

interface GridRowProps {
  nurse: Nurse;
  columns: readonly GridColumn[];
  assignmentsByCell: ReadonlyMap<string, Assignment[]>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  violationsByAssignment: ReadonlyMap<Id, Violation[]>;
  pendingIds: ReadonlySet<Id>;
  nurseViolations: readonly Violation[] | undefined;
  /** The highlighted drop target's date, when it is in this row. */
  dragOverDate: IsoDate | undefined;
  readOnly: boolean;
  onDrop: (nurseId: Id, date: IsoDate, payload: DragPayload) => void;
  onDragOverCell: (nurseId: Id, date: IsoDate, over: boolean) => void;
  onChipOpen: (assignment: Assignment) => void;
  onChipDelete: (assignment: Assignment) => void;
}

const EMPTY_ASSIGNMENTS: readonly Assignment[] = [];
const NO_PENDING: ReadonlySet<Id> = new Set();

const GridRow = memo(function GridRow({
  nurse,
  columns,
  assignmentsByCell,
  shiftTypesById,
  violationsByAssignment,
  pendingIds,
  nurseViolations,
  dragOverDate,
  readOnly,
  onDrop,
  onDragOverCell,
  onChipOpen,
  onChipDelete,
}: GridRowProps) {
  const counts = severityCounts(nurseViolations);
  return (
    <div className="flex">
      <div
        className="sticky left-0 z-10 flex w-48 shrink-0 flex-col justify-center border-b
          border-r border-border bg-surface px-3 py-1"
      >
        <p className="flex items-center text-sm font-medium text-text">
          {nurse.lastName}, {nurse.firstName}
          <CountBadge
            hard={counts.hard}
            soft={counts.soft}
            title={(nurseViolations ?? []).map((v) => v.message).join('\n')}
          />
        </p>
        <p className="text-xs text-text-muted">
          {nurse.role} · {nurse.fte.toFixed(2)} FTE
        </p>
      </div>
      {columns.map((column) => {
        const key = cellKey(nurse.id, column.date);
        return (
          <GridCell
            key={column.date}
            nurseId={nurse.id}
            date={column.date}
            assignments={assignmentsByCell.get(key) ?? EMPTY_ASSIGNMENTS}
            shiftTypesById={shiftTypesById}
            violationsByAssignment={violationsByAssignment}
            pendingIds={pendingIds}
            isDragOver={dragOverDate === column.date}
            isWeekend={column.isWeekend}
            readOnly={readOnly}
            onDrop={(payload) => onDrop(nurse.id, column.date, payload)}
            onDragOverChange={(over) => onDragOverCell(nurse.id, column.date, over)}
            onChipOpen={onChipOpen}
            onChipDelete={onChipDelete}
          />
        );
      })}
    </div>
  );
});

export interface ScheduleGridProps {
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
  columns: readonly GridColumn[];
  assignments: readonly Assignment[];
  pendingIds: ReadonlySet<Id>;
  readOnly: boolean;
  violationsByAssignment: ReadonlyMap<Id, Violation[]>;
  violationsByNurse: ReadonlyMap<Id, Violation[]>;
  violationsByDate: ReadonlyMap<IsoDate, Violation[]>;
  onMove: (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => void;
  onCreate: (input: { nurseId: Id; shiftTypeId: Id; date: IsoDate }) => void;
  onChipOpen: (assignment: Assignment) => void;
  onChipDelete: (assignment: Assignment) => void;
}

export function ScheduleGrid({
  nurses,
  shiftTypes,
  columns,
  assignments,
  pendingIds,
  readOnly,
  violationsByAssignment,
  violationsByNurse,
  violationsByDate,
  onMove,
  onCreate,
  onChipOpen,
  onChipDelete,
}: ScheduleGridProps) {
  const [dragOver, setDragOver] = useState<{ nurseId: Id; date: IsoDate } | undefined>(undefined);
  // `dragenter` on the next cell fires before `dragleave` on the last one, so a leave only
  // clears the highlight if it is still this cell's.
  const handleDragOverCell = useCallback((nurseId: Id, date: IsoDate, over: boolean) => {
    setDragOver((current) => {
      if (over) return { nurseId, date };
      return current?.nurseId === nurseId && current.date === date ? undefined : current;
    });
  }, []);

  const activeNurses = useMemo(() => sortNurses(nurses), [nurses]);
  const shiftTypesById = useMemo(() => new Map(shiftTypes.map((st) => [st.id, st])), [shiftTypes]);
  const assignmentsByCell = useMemo(() => buildCellIndex(assignments), [assignments]);
  const nursesWithPending = useMemo(() => {
    const out = new Set<Id>();
    if (pendingIds.size === 0) return out;
    for (const a of assignments) if (pendingIds.has(a.id)) out.add(a.nurseId);
    return out;
  }, [assignments, pendingIds]);

  const handleDrop = useCallback(
    (nurseId: Id, date: IsoDate, payload: DragPayload) => {
      if (payload.kind === 'move') {
        onMove({
          assignmentId: payload.assignmentId,
          nurseId,
          shiftTypeId: payload.shiftTypeId,
          date,
        });
      } else {
        onCreate({ nurseId, date, shiftTypeId: payload.shiftTypeId });
      }
    },
    [onMove, onCreate],
  );

  return (
    <div
      data-testid="schedule-grid"
      className="isolate max-h-[65vh] overflow-auto rounded-md border border-border"
    >
      <div className="inline-block min-w-full">
        <div className="flex">
          <div
            className="sticky left-0 top-0 z-30 flex w-48 shrink-0 items-end border-b border-r
              border-border bg-surface px-3 py-2 text-xs font-medium text-text-muted"
          >
            Nurse
          </div>
          {columns.map((column) => {
            const dateViolations = violationsByDate.get(column.date);
            const counts = severityCounts(dateViolations);
            return (
              <div
                key={column.date}
                className={`sticky top-0 z-20 flex h-14 w-16 shrink-0 flex-col items-center
                  justify-center border-b border-r border-border text-xs ${
                    column.isWeekend ? 'bg-bg' : 'bg-surface'
                  }`}
              >
                <span className="text-text-muted">{SHORT_WEEKDAY[column.weekday]}</span>
                <span className="flex items-center font-medium text-text">
                  {column.date.slice(8)}
                  <CountBadge
                    hard={counts.hard}
                    soft={counts.soft}
                    title={(dateViolations ?? []).map((v) => v.message).join('\n')}
                  />
                </span>
              </div>
            );
          })}
        </div>

        {activeNurses.map((nurse) => (
          <GridRow
            key={nurse.id}
            nurse={nurse}
            columns={columns}
            assignmentsByCell={assignmentsByCell}
            shiftTypesById={shiftTypesById}
            violationsByAssignment={violationsByAssignment}
            pendingIds={nursesWithPending.has(nurse.id) ? pendingIds : NO_PENDING}
            nurseViolations={violationsByNurse.get(nurse.id)}
            dragOverDate={dragOver?.nurseId === nurse.id ? dragOver.date : undefined}
            readOnly={readOnly}
            onDrop={handleDrop}
            onDragOverCell={handleDragOverCell}
            onChipOpen={onChipOpen}
            onChipDelete={onChipDelete}
          />
        ))}
      </div>
    </div>
  );
}
