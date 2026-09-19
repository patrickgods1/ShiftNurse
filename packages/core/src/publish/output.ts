/**
 * The printable and exportable projections of a schedule: the unit grid the manager pins on
 * the wall and the per-nurse sheet each nurse takes home.
 *
 * These are plain data, not documents. The PDF renderer, the CSV writer and the future
 * nurse-facing schedule viewer all start from the same projection, so a shift can never be
 * printed on the grid and missing from a nurse's sheet — both are views of one `ScheduleView`.
 * Keeping the projection here (and not in the Electron host) is also what makes the output
 * checkable by hand in a unit test rather than by opening a PDF.
 *
 * Conventions that follow how units read paper schedules:
 * - Rows sort by surname, then first name. The grid is looked up by name, not employee id.
 * - A charge nurse's cell is marked with `*` after the abbreviation.
 * - On-call hours are shown separately from worked hours: standby is not a shift worked.
 * - The long CSV (`employee_id,date,shift`) is exactly the history-import format, so a
 *   published period exported today can be re-imported as history on another machine.
 */

import type { Id, Nurse, ShiftType } from '../domain/entities.js';
import {
  formatTimeOfDay,
  hoursToMinutes,
  type IsoDate,
  MINUTES_PER_DAY,
  parseTimeOfDay,
  WEEKDAY_NAMES,
  weekdayOf,
} from '../domain/time.js';
import { HISTORY_COLUMNS } from '../fairness/history-csv.js';
import { serializeCsv } from '../roster/csv.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';

export interface GridCell {
  assignmentId: Id;
  shiftTypeId: Id;
  /** Abbreviation, with `*` for the charge nurse and `OT` for authorised overtime. */
  label: string;
  isCharge: boolean;
  isOvertime: boolean;
}

export interface GridRow {
  nurse: Nurse;
  /** One entry per date in `GridSheet.dates`, each holding that day's shifts in start order. */
  cells: GridCell[][];
  /** Worked hours in the period, on-call excluded. */
  hours: number;
  onCallHours: number;
}

export interface DailyCount {
  shiftType: ShiftType;
  /** Heads on this shift per date, aligned with `GridSheet.dates`. */
  counts: number[];
}

export interface GridSheet {
  periodName: string;
  startDate: IsoDate;
  endDate: IsoDate;
  dates: IsoDate[];
  rows: GridRow[];
  /** Shift types that appear at least once, in `sortOrder` — the legend and footer. */
  dailyCounts: DailyCount[];
}

export interface NurseSheetShift {
  assignmentId: Id;
  date: IsoDate;
  /** `Sun`…`Sat`. */
  weekday: string;
  label: string;
  shiftTypeName: string;
  start: string;
  end: string;
  hours: number;
  isOnCall: boolean;
  isCharge: boolean;
  isOvertime: boolean;
  notes?: string;
}

export interface NurseSheet {
  nurse: Nurse;
  periodName: string;
  startDate: IsoDate;
  endDate: IsoDate;
  shifts: NurseSheetShift[];
  /** Worked hours, on-call excluded. */
  totalHours: number;
  onCallHours: number;
  contractedHours: number;
}

function byName(a: Nurse, b: Nurse): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName) ||
    a.employeeId.localeCompare(b.employeeId)
  );
}

function cellLabel(view: AssignmentView): string {
  let label = view.shiftType.abbreviation;
  if (view.assignment.isCharge) label += '*';
  if (view.assignment.isOvertime) label += ' OT';
  return label;
}

function workedHours(views: readonly AssignmentView[]): number {
  return views.filter((v) => !v.shiftType.isOnCall).reduce((s, v) => s + v.paidHours, 0);
}

function onCallHours(views: readonly AssignmentView[]): number {
  return views.filter((v) => v.shiftType.isOnCall).reduce((s, v) => s + v.paidHours, 0);
}

export function buildGridSheet(schedule: ScheduleView): GridSheet {
  const dates = [...schedule.dates];
  const nurses = [...schedule.nursesById.values()].filter((n) => n.active).sort(byName);
  const rows: GridRow[] = nurses.map((nurse) => {
    const views = schedule.assignmentsFor(nurse.id);
    const cells: GridCell[][] = dates.map((date) =>
      views
        .filter((v) => v.assignment.date === date)
        .map((v) => ({
          assignmentId: v.assignment.id,
          shiftTypeId: v.shiftType.id,
          label: cellLabel(v),
          isCharge: v.assignment.isCharge,
          isOvertime: v.assignment.isOvertime,
        })),
    );
    return { nurse, cells, hours: workedHours(views), onCallHours: onCallHours(views) };
  });

  const used = new Map<Id, ShiftType>();
  for (const v of schedule.assignments()) used.set(v.shiftType.id, v.shiftType);
  const dailyCounts: DailyCount[] = [...used.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.abbreviation.localeCompare(b.abbreviation))
    .map((shiftType) => ({
      shiftType,
      counts: dates.map((date) => schedule.onShift(date, shiftType.id).length),
    }));

  return {
    periodName: schedule.period.name,
    startDate: schedule.period.startDate,
    endDate: schedule.period.endDate,
    dates,
    rows,
    dailyCounts,
  };
}

function shortWeekday(date: IsoDate): string {
  return WEEKDAY_NAMES[weekdayOf(date)].slice(0, 3);
}

/** One sheet per nurse who has at least one shift, in grid order. */
export function buildNurseSheets(schedule: ScheduleView): NurseSheet[] {
  const nurses = [...schedule.nursesById.values()].sort(byName);
  const sheets: NurseSheet[] = [];
  for (const nurse of nurses) {
    const views = schedule.assignmentsFor(nurse.id);
    if (views.length === 0) continue;
    const shifts: NurseSheetShift[] = views.map((v) => {
      const startMinute = parseTimeOfDay(v.shiftType.startTime);
      const endMinute = (startMinute + hoursToMinutes(v.shiftType.durationHours)) % MINUTES_PER_DAY;
      return {
        assignmentId: v.assignment.id,
        date: v.assignment.date,
        weekday: shortWeekday(v.assignment.date),
        label: v.shiftType.abbreviation,
        shiftTypeName: v.shiftType.name,
        start: formatTimeOfDay(startMinute),
        end: formatTimeOfDay(endMinute),
        hours: v.paidHours,
        isOnCall: v.shiftType.isOnCall,
        isCharge: v.assignment.isCharge,
        isOvertime: v.assignment.isOvertime,
        ...(v.assignment.notes !== undefined ? { notes: v.assignment.notes } : {}),
      };
    });
    sheets.push({
      nurse,
      periodName: schedule.period.name,
      startDate: schedule.period.startDate,
      endDate: schedule.period.endDate,
      shifts,
      totalHours: workedHours(views),
      onCallHours: onCallHours(views),
      contractedHours: nurse.contractedHoursPerPeriod,
    });
  }
  return sheets;
}

/** The grid as a spreadsheet: one row per nurse, one column per date, hours at the end. */
export function formatGridCsv(sheet: GridSheet): string {
  const header = ['employee_id', 'name', 'role', ...sheet.dates, 'hours'];
  const body = sheet.rows.map((row) => [
    row.nurse.employeeId,
    `${row.nurse.lastName}, ${row.nurse.firstName}`,
    row.nurse.role,
    ...row.cells.map((cell) => cell.map((c) => c.label).join(' ')),
    String(row.hours),
  ]);
  return serializeCsv([header, ...body]);
}

/** One row per shift in the history-import format, so the export can be re-imported. */
export function formatAssignmentsCsv(schedule: ScheduleView): string {
  const nurses = [...schedule.nursesById.values()].sort(byName);
  const body: string[][] = [];
  for (const nurse of nurses) {
    for (const v of schedule.assignmentsFor(nurse.id)) {
      body.push([nurse.employeeId, v.assignment.date, v.shiftType.abbreviation]);
    }
  }
  return serializeCsv([[...HISTORY_COLUMNS], ...body]);
}
