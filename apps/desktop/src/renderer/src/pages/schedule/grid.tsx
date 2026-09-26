/**
 * The nurse x day grid. Rows are memoised (`React.memo` + stable callbacks from the parent) so
 * that redrawing 42 nurses x 42 days on every validation refresh doesn't mean re-rendering
 * every cell that didn't change — only the row(s) whose props actually differ do. That only
 * holds if per-row props are per-row: a row sees the drag highlight only when it is in that
 * row, and the pending set only when one of its own shifts is pending.
 *
 * Keyboard: a roving tabindex, as ARIA's grid pattern describes. The tab stops are the active
 * cell and the shift chips inside it — every other cell and chip is `tabIndex=-1` — so Tab enters
 * the grid, reaches that cell's shifts, and leaves. Arrow keys move the active cell, Home/End jump
 * along the row, and Enter on a cell opens the shift-type picker (the keyboard route for
 * dropping a palette shift there). A chip opens its dialog with Enter, where "Move to" is the
 * keyboard route for dragging it.
 *
 * Violation indexes are built once per validation result by the caller (`board.tsx`) and passed
 * in as plain maps, so this component never re-walks the violations array itself.
 */

import type { Assignment, Id, IsoDate, Nurse, ShiftType, Violation } from '@shiftnurse/core';
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanelFocus } from '../../components/use-panel-focus.js';
import { formatDateWithWeekday } from '../../format.js';
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
  nurseLabel: string;
  date: IsoDate;
  row: number;
  col: number;
  /** The grid's single tab stop. */
  tabbable: boolean;
  onFocusCell: (row: number, col: number) => void;
  onOpenPicker: (nurseId: Id, date: IsoDate, cell: HTMLElement) => void;
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
  nurseId,
  nurseLabel,
  date,
  row,
  col,
  tabbable,
  onFocusCell,
  onOpenPicker,
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
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
    <div
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-cell={`${row}:${col}`}
      aria-label={`${nurseLabel}, ${formatDateWithWeekday(date)}: ${
        assignments.length === 0
          ? 'no shift'
          : `${assignments.length} shift${assignments.length === 1 ? '' : 's'}`
      }`}
      // Focus landing on a chip (a click, say) makes its cell the active one too.
      onFocus={() => onFocusCell(row, col)}
      onKeyDown={(event) => {
        if (readOnly || event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenPicker(nurseId, date, event.currentTarget);
        }
      }}
      className={`flex h-14 w-16 shrink-0 flex-col items-center justify-center border-b border-r
        border-border px-0.5 focus-visible:outline focus-visible:outline-2
        focus-visible:-outline-offset-2 focus-visible:outline-accent ${isWeekend ? 'bg-bg' : 'bg-surface'} ${
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
          tabbable={tabbable}
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
  row: number;
  /** The column of the grid's tab stop, when it is in this row. */
  activeCol: number | undefined;
  onFocusCell: (row: number, col: number) => void;
  onOpenPicker: (nurseId: Id, date: IsoDate, cell: HTMLElement) => void;
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
  row,
  activeCol,
  onFocusCell,
  onOpenPicker,
  readOnly,
  onDrop,
  onDragOverCell,
  onChipOpen,
  onChipDelete,
}: GridRowProps) {
  const counts = severityCounts(nurseViolations);
  const nurseLabel = `${nurse.firstName} ${nurse.lastName}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
    // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
    <div role="row" className="flex">
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
      <div
        role="rowheader"
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
      {columns.map((column, col) => {
        const key = cellKey(nurse.id, column.date);
        return (
          <GridCell
            key={column.date}
            nurseId={nurse.id}
            nurseLabel={nurseLabel}
            date={column.date}
            row={row}
            col={col}
            tabbable={activeCol === col}
            onFocusCell={onFocusCell}
            onOpenPicker={onOpenPicker}
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
  const gridRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [picker, setPicker] = useState<
    { nurseId: Id; date: IsoDate; top: number; left: number } | undefined
  >(undefined);

  const handleFocusCell = useCallback((row: number, col: number) => {
    setActive((current) => (current.row === row && current.col === col ? current : { row, col }));
  }, []);
  const handleOpenPicker = useCallback((nurseId: Id, date: IsoDate, cell: HTMLElement) => {
    const rect = cell.getBoundingClientRect();
    setPicker({ nurseId, date, top: rect.bottom + 4, left: rect.left });
  }, []);

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).dataset.cell;
    if (cell === undefined) return;
    const [row = 0, col = 0] = cell.split(':').map(Number);
    const lastRow = activeNurses.length - 1;
    const lastCol = columns.length - 1;
    const next =
      event.key === 'ArrowUp'
        ? { row: Math.max(0, row - 1), col }
        : event.key === 'ArrowDown'
          ? { row: Math.min(lastRow, row + 1), col }
          : event.key === 'ArrowLeft'
            ? { row, col: Math.max(0, col - 1) }
            : event.key === 'ArrowRight'
              ? { row, col: Math.min(lastCol, col + 1) }
              : event.key === 'Home'
                ? { row, col: 0 }
                : event.key === 'End'
                  ? { row, col: lastCol }
                  : undefined;
    if (!next) return;
    event.preventDefault();
    setActive(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.col}"]`)?.focus();
  };
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
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
    <div
      ref={gridRef}
      role="grid"
      aria-label="Schedule: nurses by day"
      aria-rowcount={activeNurses.length + 1}
      aria-colcount={columns.length + 1}
      data-testid="schedule-grid"
      onKeyDown={handleGridKeyDown}
      className="isolate max-h-[65vh] overflow-auto rounded-md border border-border"
    >
      <div className="inline-block min-w-full">
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
        <div role="row" className="flex">
          {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
          <div
            role="columnheader"
            className="sticky left-0 top-0 z-30 flex w-48 shrink-0 items-end border-b border-r
              border-border bg-surface px-3 py-2 text-xs font-medium text-text-muted"
          >
            Nurse
          </div>
          {columns.map((column) => {
            const dateViolations = violationsByDate.get(column.date);
            const counts = severityCounts(dateViolations);
            return (
              // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
              // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
              <div
                key={column.date}
                role="columnheader"
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

        {activeNurses.map((nurse, row) => (
          <GridRow
            key={nurse.id}
            nurse={nurse}
            row={row}
            activeCol={active.row === row ? active.col : undefined}
            onFocusCell={handleFocusCell}
            onOpenPicker={handleOpenPicker}
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
      {picker ? (
        <ShiftPicker
          shiftTypes={shiftTypes}
          date={picker.date}
          top={picker.top}
          left={picker.left}
          onPick={(shiftTypeId) => {
            onCreate({ nurseId: picker.nurseId, date: picker.date, shiftTypeId });
            setPicker(undefined);
          }}
          onClose={() => setPicker(undefined)}
        />
      ) : null}
    </div>
  );
}

/** The keyboard route for dropping a palette shift on a cell: one button per active shift type. */
function ShiftPicker({
  shiftTypes,
  date,
  top,
  left,
  onPick,
  onClose,
}: {
  shiftTypes: readonly ShiftType[];
  date: IsoDate;
  top: number;
  left: number;
  onPick: (shiftTypeId: Id) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelFocus(ref, true, onClose);
  // A click anywhere else dismisses it, as a menu would.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);
  // Opened from a cell near the window's bottom or right edge, it would spill off-screen.
  const style = {
    top: Math.min(top, window.innerHeight - 8 - 40 * (shiftTypes.length + 1)),
    left: Math.min(left, window.innerWidth - 8 - 176),
  };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Add a shift on ${formatDateWithWeekday(date)}`}
      data-testid="shift-picker"
      style={style}
      className="fixed z-40 flex w-44 flex-col gap-1 rounded-md border border-border bg-surface p-2
        shadow-lg"
    >
      <p className="px-1 text-xs font-medium text-text-muted">Add a shift</p>
      {shiftTypes
        .filter((st) => st.active)
        .map((st) => (
          <button
            key={st.id}
            type="button"
            onClick={() => onPick(st.id)}
            className="rounded px-2 py-1 text-left text-sm text-text hover:bg-bg focus-visible:bg-bg
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="font-medium">{st.abbreviation}</span> {st.name}
          </button>
        ))}
    </div>
  );
}
