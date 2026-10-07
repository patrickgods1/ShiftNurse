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

import type {
  Assignment,
  Id,
  IsoDate,
  Nurse,
  Preference,
  ShiftDemand,
  ShiftType,
  Violation,
} from '@shiftnurse/core';
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePanelFocus } from '../../components/use-panel-focus.js';
import { formatDateWithWeekday, fteLabel, listName } from '../../format.js';
import { describePreference } from '../../preferences.js';
import { AssignmentChip } from './chip.js';
import type { DragPayload } from './dnd.js';
import { readDragPayload } from './dnd.js';
import {
  buildCellIndex,
  cellKey,
  headcountRows,
  monthSpans,
  SHORT_WEEKDAY,
  sortNurses,
  staffingSummary,
} from './grid-utils.js';

export interface GridColumn {
  date: IsoDate;
  weekday: number;
  isWeekend: boolean;
  /** The first day of a new week after the first: drawn with a heavier divider. */
  weekStart?: boolean;
}

/** The divider that separates weeks, so six weeks of columns read as weeks, not a blur. */
const WEEK_DIVIDER = 'border-l-2 border-l-text-muted/40';

/**
 * What a "Show on grid" link points at: a day, and when the alert names one, a nurse and the
 * shifts behind it. `nonce` changes on every click so the same link pressed twice scrolls twice.
 */
export interface GridSpotlight {
  date: IsoDate;
  nurseId?: Id | undefined;
  assignmentIds: readonly Id[];
  nonce: number;
}

/** The problem the manager asked to see: a ring that pulses until the spotlight clears. */
const SPOTLIGHT_CELL = 'ring-2 ring-inset ring-danger bg-danger/10 animate-pulse';
const SPOTLIGHT_COLUMN = 'bg-danger/10';
const EMPTY_IDS: ReadonlySet<Id> = new Set();

const EMPTY_VIOLATIONS: readonly Violation[] = [];

/** Height of one row under the grid, in rem; the sticky offsets stack in these units. */
const FOOTER_ROW_REM = 1.75;
const BREAKDOWN_KEY = 'shiftnurse.staffingBreakdownOpen';

/**
 * Whether the per-shift headcount rows are open. Closed by default: one row per shift type and
 * role, all sticky, took a third of the grid's height at 1366×768 — the summary row says which
 * days are short, and the breakdown is a click away. Remembered per viewer, as the legend is.
 */
function useBreakdownOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(BREAKDOWN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(BREAKDOWN_KEY, next ? '1' : '0');
    } catch {
      // Not remembering is harmless.
    }
  }, [open]);
  return [open, toggle];
}

function severityCounts(violations: readonly Violation[] | undefined): {
  hard: number;
  soft: number;
} {
  if (!violations || violations.length === 0) return { hard: 0, soft: 0 };
  let hard = 0;
  for (const v of violations) if (v.severity === 'hard') hard += 1;
  return { hard, soft: violations.length - hard };
}

/** The nearest ancestor that scrolls — the page's `<main>` — or none in a test's bare document. */
function scrollParent(el: HTMLElement): HTMLElement | undefined {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return undefined;
}

function CountBadge({ hard, soft, title }: { hard: number; soft: number; title: string }) {
  if (hard === 0 && soft === 0) return null;
  return (
    <span
      title={title}
      className={`ml-1 inline-flex min-w-[1rem] items-center justify-center rounded-full px-1
        text-xs font-semibold ${hard > 0 ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'}`}
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
  /** Shifts to mark as differing from the draft (`nurseId|date|shiftTypeId`), when previewing. */
  highlightKeys: ReadonlySet<string> | undefined;
  isDragOver: boolean;
  isWeekend: boolean;
  weekStart: boolean;
  readOnly: boolean;
  /** 'cell' when a link points at this nurse's day, 'column' when at the day alone. */
  spotlit: 'cell' | 'column' | undefined;
  /** The shifts that link names, ringed inside the cell. */
  spotlightIds: ReadonlySet<Id>;
  onDrop: (payload: DragPayload) => void;
  onDragOverChange: (over: boolean) => void;
  onChipOpen: (assignment: Assignment) => void;
  onChipDelete: (assignment: Assignment) => void;
  preferenceNotes: ReadonlyMap<Id, string>;
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
  highlightKeys,
  isDragOver,
  isWeekend,
  weekStart,
  readOnly,
  spotlit,
  spotlightIds,
  onDrop,
  onDragOverChange,
  onChipOpen,
  onChipDelete,
  preferenceNotes,
}: GridCellProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
    <div
      role="gridcell"
      tabIndex={tabbable ? 0 : -1}
      data-cell={`${row}:${col}`}
      data-spotlit={spotlit}
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
        focus-visible:-outline-offset-2 focus-visible:outline-accent ${weekStart ? WEEK_DIVIDER : ''} ${isWeekend ? 'bg-bg' : 'bg-surface'} ${
          isDragOver ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
        } ${spotlit === 'cell' ? SPOTLIGHT_CELL : spotlit === 'column' ? SPOTLIGHT_COLUMN : ''}`}
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
          highlighted={
            highlightKeys?.has(
              `${assignment.nurseId}|${assignment.date}|${assignment.shiftTypeId}`,
            ) ?? false
          }
          onOpen={onChipOpen}
          onDelete={onChipDelete}
          tabbable={tabbable}
          preferenceNote={preferenceNotes.get(assignment.id)}
          spotlit={spotlightIds.has(assignment.id)}
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
  highlightKeys: ReadonlySet<string> | undefined;
  /** This row is the nurse a link asked to see; a boolean so no other row re-renders. */
  highlighted: boolean;
  nurseViolations: readonly Violation[] | undefined;
  /** The day a link points at, when it is this nurse's or every nurse's. */
  spotlightDate: IsoDate | undefined;
  /** Whether that link named this nurse (a cell) or only the day (the column). */
  spotlightKind: 'cell' | 'column';
  spotlightIds: ReadonlySet<Id>;
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
  preferenceNotes: ReadonlyMap<Id, string>;
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
  highlightKeys,
  highlighted,
  spotlightDate,
  spotlightKind,
  spotlightIds,
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
  preferenceNotes,
}: GridRowProps) {
  const counts = severityCounts(nurseViolations);
  const nurseLabel = `${nurse.firstName} ${nurse.lastName}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
    // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
    <div
      role="row"
      data-nurse-id={nurse.id}
      data-highlighted={highlighted ? 'true' : undefined}
      className={highlighted ? 'flex bg-accent/10 ring-2 ring-inset ring-accent' : 'flex'}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
      <div
        role="rowheader"
        className="sticky left-0 z-10 flex w-48 shrink-0 flex-col justify-center border-b
          border-r border-border bg-surface px-3 py-1"
      >
        <p className="flex items-center text-sm font-medium text-text">
          {listName(nurse)}
          <CountBadge
            hard={counts.hard}
            soft={counts.soft}
            title={(nurseViolations ?? []).map((v) => v.message).join('\n')}
          />
        </p>
        <p className="text-xs text-text-muted">
          {nurse.role} · {fteLabel(nurse)}
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
            highlightKeys={highlightKeys}
            isDragOver={dragOverDate === column.date}
            isWeekend={column.isWeekend}
            weekStart={column.weekStart ?? false}
            readOnly={readOnly}
            spotlit={spotlightDate === column.date ? spotlightKind : undefined}
            spotlightIds={spotlightDate === column.date ? spotlightIds : EMPTY_IDS}
            onDrop={(payload) => onDrop(nurse.id, column.date, payload)}
            onDragOverChange={(over) => onDragOverCell(nurse.id, column.date, over)}
            onChipOpen={onChipOpen}
            onChipDelete={onChipDelete}
            preferenceNotes={preferenceNotes}
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
  /** While previewing a Generate variation: its shifts that differ from the draft. */
  highlightKeys?: ReadonlySet<string>;
  /** Marks this nurse's row (and the board scrolls to it). */
  focusNurseId?: Id | undefined;
  /** A problem a link asked to see: the grid scrolls to it and rings it. */
  spotlight?: GridSpotlight | undefined;
  violationsByAssignment: ReadonlyMap<Id, Violation[]>;
  violationsByNurse: ReadonlyMap<Id, Violation[]>;
  violationsByDate: ReadonlyMap<IsoDate, Violation[]>;
  onMove: (input: { assignmentId: Id; nurseId: Id; shiftTypeId: Id; date: IsoDate }) => void;
  onCreate: (input: { nurseId: Id; shiftTypeId: Id; date: IsoDate }) => void;
  onChipOpen: (assignment: Assignment) => void;
  onChipDelete: (assignment: Assignment) => void;
  /** The period's staffing demand, for the headcount rows under the grid. */
  demand?: readonly ShiftDemand[];
  /** Assignment id → the preferences that shift goes against (`schedule.validate`). */
  againstPreference?: Readonly<Record<Id, readonly Preference[]>>;
}

export function ScheduleGrid({
  nurses,
  shiftTypes,
  columns,
  assignments,
  pendingIds,
  readOnly,
  highlightKeys,
  focusNurseId,
  spotlight,
  violationsByAssignment,
  violationsByNurse,
  violationsByDate,
  onMove,
  onCreate,
  onChipOpen,
  onChipDelete,
  demand,
  againstPreference,
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

  // The grid's own scroll area ends at the window bottom, whatever sits above it (the status
  // row, an open detail panel, the candidates bar): a fixed `calc(100vh - N)` was right for one
  // layout and a second page scrollbar for every other. 1.5rem is the page's bottom padding.
  //
  // The room is measured as if the page were scrolled to the top. Measured from the viewport
  // instead, scrolling the page down moved the grid's top up, so the grid grew by the same
  // amount, the page gained that much more to scroll, and the manager could scroll the date row
  // clean off the screen — the one row the sticky header exists to keep in view.
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const fit = () => {
      const scroller = scrollParent(el);
      const top = el.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
      const room = window.innerHeight - top - 24;
      el.style.maxHeight = `${Math.max(240, Math.floor(room))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    // Content above the grid growing or shrinking moves its top without a window resize.
    // Re-fit on the next frame: resizing inside the observer's own callback is the "loop
    // completed with undelivered notifications" error.
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const observer =
      typeof ResizeObserver === 'undefined' || !el.parentElement
        ? undefined
        : new ResizeObserver(refit);
    if (observer && el.parentElement) observer.observe(el.parentElement);
    return () => {
      window.removeEventListener('resize', fit);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  // A link's target: the nurse's cell on that day, or the day's header when no nurse is named.
  // Keyed on the nonce so the same link pressed twice scrolls twice.
  useEffect(() => {
    const grid = gridRef.current;
    if (!spotlight || !grid) return;
    const col = columns.findIndex((c) => c.date === spotlight.date);
    const row = activeNurses.findIndex((n) => n.id === spotlight.nurseId);
    const target =
      row >= 0 && col >= 0
        ? grid.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)
        : [...grid.querySelectorAll<HTMLElement>('[role="columnheader"][data-date]')].find(
            (header) => header.dataset.date === spotlight.date,
          );
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    // The nonce is the trigger; a new spotlight with the same target still scrolls.
  }, [spotlight, columns, activeNurses]);
  const spotlightIds = useMemo(
    () => (spotlight ? new Set(spotlight.assignmentIds) : EMPTY_IDS),
    [spotlight],
  );
  const months = useMemo(() => monthSpans(columns.map((c) => c.date)), [columns]);
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
  const preferenceNotes = useMemo(() => {
    const notes = new Map<Id, string>();
    if (!againstPreference) return notes;
    const names = new Map(shiftTypes.map((st) => [st.id, st.name]));
    const nurseById = new Map(nurses.map((n) => [n.id, n]));
    for (const [assignmentId, prefs] of Object.entries(againstPreference)) {
      const nurse = nurseById.get(prefs[0]?.nurseId ?? '');
      const who = nurse ? `${nurse.firstName} ${nurse.lastName}` : 'the nurse';
      notes.set(
        assignmentId,
        `Goes against ${who}'s request: ${prefs.map((p) => describePreference(p, names)).join('; ')}`,
      );
    }
    return notes;
  }, [againstPreference, shiftTypes, nurses]);
  const headcount = useMemo(
    () =>
      headcountRows({
        shiftTypes,
        nurses,
        assignments,
        demand: demand ?? [],
        dates: columns.map((c) => c.date),
      }),
    [shiftTypes, nurses, assignments, demand, columns],
  );
  const summary = useMemo(
    () =>
      staffingSummary(
        headcount,
        columns.map((c) => c.date),
      ),
    [headcount, columns],
  );
  const [breakdownOpen, toggleBreakdown] = useBreakdownOpen();
  const breakdown = breakdownOpen ? headcount : [];
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
      aria-rowcount={activeNurses.length + 2 + (headcount.length > 0 ? 1 + breakdown.length : 0)}
      aria-colcount={columns.length + 1}
      data-testid="schedule-grid"
      onKeyDown={handleGridKeyDown}
      className="isolate max-h-[calc(100vh-14rem)] overflow-auto rounded-md border border-border"
    >
      <div className="inline-block min-w-full">
        {/* The month band: a six-week schedule crosses a month, and "29, 30, 31, 1, 2" alone
            does not say which. Each month's name stays in view while its columns scroll by. */}
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
        <div role="row" data-testid="month-band" className="flex">
          {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
          <div
            role="columnheader"
            aria-label="Month"
            className="sticky left-0 top-0 z-30 h-6 w-48 shrink-0 border-r border-border bg-surface"
          />
          {months.map((month) => (
            // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
            // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
            <div
              key={month.label}
              role="columnheader"
              aria-colspan={month.count}
              className={`sticky top-0 z-20 flex h-6 shrink-0 items-center overflow-x-clip border-r
                border-border bg-surface text-xs font-semibold text-text ${
                  month.start > 0 ? 'border-l-2 border-l-text-muted/40' : ''
                }`}
              style={{ width: `${month.count * 4}rem` }}
            >
              <span className="sticky left-48 whitespace-nowrap px-2">{month.label}</span>
            </div>
          ))}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
        <div role="row" className="flex">
          {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
          {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
          <div
            role="columnheader"
            className="sticky left-0 top-6 z-30 flex w-48 shrink-0 items-end border-b border-r
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
                data-date={column.date}
                role="columnheader"
                data-spotlit={spotlight?.date === column.date ? 'column' : undefined}
                className={`sticky top-6 z-20 flex h-14 w-16 shrink-0 flex-col items-center
                  justify-center border-b border-r border-border text-xs ${
                    column.weekStart ? WEEK_DIVIDER : ''
                  } ${column.isWeekend ? 'bg-bg' : 'bg-surface'} ${
                    spotlight?.date === column.date ? SPOTLIGHT_CELL : ''
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
            highlightKeys={highlightKeys}
            highlighted={nurse.id === focusNurseId}
            spotlightDate={
              spotlight && (spotlight.nurseId === undefined || spotlight.nurseId === nurse.id)
                ? spotlight.date
                : undefined
            }
            spotlightKind={spotlight?.nurseId === undefined ? 'column' : 'cell'}
            spotlightIds={spotlight?.nurseId === nurse.id ? spotlightIds : EMPTY_IDS}
            nurseViolations={violationsByNurse.get(nurse.id)}
            dragOverDate={dragOver?.nurseId === nurse.id ? dragOver.date : undefined}
            readOnly={readOnly}
            onDrop={handleDrop}
            onDragOverCell={handleDragOverCell}
            onChipOpen={onChipOpen}
            onChipDelete={onChipDelete}
            preferenceNotes={preferenceNotes}
          />
        ))}
        {headcount.length > 0 ? (
          // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
          // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
          <div
            role="row"
            data-testid="staffing-summary"
            className="sticky z-10 flex"
            style={{ bottom: `${breakdown.length * FOOTER_ROW_REM}rem` }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: the toggle inside is the focusable part */}
            <div
              role="rowheader"
              className="sticky left-0 z-20 flex h-7 w-48 shrink-0 items-center border-r
                border-t-2 border-border border-t-text-muted/40 bg-bg px-1 text-xs text-text-muted"
            >
              <button
                type="button"
                data-testid="staffing-breakdown-toggle"
                aria-expanded={breakdownOpen}
                onClick={toggleBreakdown}
                className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-left
                  hover:bg-border/40"
              >
                <span aria-hidden="true">{breakdownOpen ? '▾' : '▸'}</span>
                Staffing
                <span className="ml-auto">{breakdownOpen ? 'hide shifts' : 'by shift'}</span>
              </button>
            </div>
            {summary.map((cell, col) => (
              // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
              // biome-ignore lint/a11y/useFocusableInteractive: a read-only total; the roving tab stop stays on the nurse cells
              <div
                key={cell.date}
                role="gridcell"
                title={
                  cell.short > 0
                    ? `${cell.short} short on ${formatDateWithWeekday(cell.date)}: ${cell.details.join(', ')} (staffed/needed)`
                    : `Every shift has its minimum on ${formatDateWithWeekday(cell.date)}`
                }
                className={`flex h-7 w-16 shrink-0 items-center justify-center border-r border-t-2
                  border-border border-t-text-muted/40 bg-bg text-xs ${
                    columns[col]?.weekStart ? WEEK_DIVIDER : ''
                  } ${cell.short > 0 ? 'font-semibold text-danger' : 'text-text-muted'}`}
              >
                {cell.short > 0 ? `${cell.short} short` : '✓'}
              </div>
            ))}
          </div>
        ) : null}
        {breakdown.map((line, i) => (
          // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
          // biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops
          <div
            key={`${line.shiftType.id}:${line.role}`}
            role="row"
            data-testid="headcount-row"
            className="sticky z-10 flex"
            style={{ bottom: `${(breakdown.length - 1 - i) * FOOTER_ROW_REM}rem` }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header) */}
            {/* biome-ignore lint/a11y/useFocusableInteractive: one roving tab stop per grid; headers and rows are not tab stops */}
            <div
              role="rowheader"
              className="sticky left-0 z-20 flex h-7 w-48 shrink-0 items-center border-r
                border-border bg-bg px-3 pl-7 text-xs text-text-muted"
            >
              {line.shiftType.abbreviation} {line.role}s on shift
            </div>
            {line.cells.map((cell, col) => {
              const short = cell.staffed < cell.required;
              return (
                // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern on a flex layout with sticky headers (see the module header)
                // biome-ignore lint/a11y/useFocusableInteractive: a read-only total; the roving tab stop stays on the nurse cells
                <div
                  key={cell.date}
                  role="gridcell"
                  title={
                    cell.required > 0
                      ? `${cell.staffed} of ${cell.required} ${line.role}s needed on ${line.shiftType.name}, ${formatDateWithWeekday(cell.date)}`
                      : `${cell.staffed} ${line.role}s on ${line.shiftType.name}, ${formatDateWithWeekday(cell.date)}`
                  }
                  className={`flex h-7 w-16 shrink-0 items-center justify-center border-r
                    border-border bg-bg text-xs ${columns[col]?.weekStart ? WEEK_DIVIDER : ''} ${
                      short ? 'font-semibold text-danger' : 'text-text-muted'
                    }`}
                >
                  {cell.required > 0 ? `${cell.staffed}/${cell.required}` : cell.staffed}
                </div>
              );
            })}
          </div>
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
