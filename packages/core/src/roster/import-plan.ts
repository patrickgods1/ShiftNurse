/**
 * Roster import plan: the one rule for "what does this sheet change for nurses already on the
 * unit".
 *
 * The import preview and the import itself both call `rosterChangesFor`, so what the manager is
 * shown before pressing Import is exactly what gets written. Without one shared rule the two
 * drift: the preview would say "12 to update" while the import quietly cleared every 72/80 plan
 * and note on the unit because HR's export had no `schedule_kind` or `notes` column, and a
 * departed nurse in last year's sheet would be back in Generate's pool without anyone deciding
 * that.
 *
 * So a column the file does not carry changes nothing, a column it carries with a blank cell
 * clears the field (the sheet is the source of truth for what it holds), and an inactive match
 * is reported rather than reactivated: whether to bring her back is the manager's call, made by
 * the caller. Credentials are not covered: the import only grants and updates them, never
 * revokes, and the database layer counts those.
 *
 * A sheet's employee id finds a stored nurse trimmed and case-folded (`matchStoredNurse`):
 * payroll exports and hand-typed sheets disagree on case, and an exact match would create a
 * second person with her own seniority, ledger and audit trail. Two stored nurses matching is
 * reported as ambiguous, never guessed.
 */

import { EMPLOYMENT_TYPE_LABELS, type Nurse, SCHEDULE_KIND_LABELS } from '../domain/entities.js';
import {
  REQUIRED_COLUMNS,
  ROSTER_COLUMNS,
  type RosterColumn,
  type RosterCsvRow,
  type RosterNurseFields,
} from './csv.js';

/** Columns that may be missing from a sheet; every other column is required. */
export const OPTIONAL_ROSTER_COLUMNS: readonly RosterColumn[] = ROSTER_COLUMNS.filter(
  (c) => !REQUIRED_COLUMNS.includes(c),
);

/** A nurse field as an import would set it; `null` clears an optional field. */
export type RosterNurseUpdate = {
  [K in keyof RosterNurseFields]?: undefined extends RosterNurseFields[K]
    ? Exclude<RosterNurseFields[K], undefined> | null
    : RosterNurseFields[K];
};

export interface RosterFieldChange {
  /** The manager's name for the field: 'Schedule plan', 'Notes', 'Charge eligible'… */
  field: string;
  /** Display text; undefined = not set. */
  from: string | undefined;
  to: string | undefined;
}

export interface RosterImportPlanRow {
  employeeId: string;
  /** "Cruz, Ana", from the file. */
  name: string;
  /** `ambiguous`: the id matches two stored nurses; the import refuses until one is renamed. */
  action: 'create' | 'update' | 'unchanged' | 'ambiguous';
  /** The matched nurse is inactive; the import reactivates only when asked. */
  inactive: boolean;
  changes: RosterFieldChange[];
}

/**
 * How a present column treats its cell. `set`: the parsed value always stands (required
 * columns, hours, and yes/no flags where blank already means no). `clear`: a blank cell clears
 * the field. `when_filled`: a blank cell keeps the stored value, because scheduled days are an
 * agreement with one nurse that a sheet which never filled them must not erase.
 */
type CellRule = 'set' | 'clear' | 'when_filled';

interface FieldRule {
  key: Exclude<keyof RosterNurseFields, 'employeeId' | 'permanentTour'>;
  column: RosterColumn;
  label: string;
  cell: CellRule;
  show: (value: string | number | boolean) => string;
}

const text = (v: string | number | boolean) => String(v);
const yesNo = (v: string | number | boolean) => (v ? 'yes' : 'no');

// In the order the preview lists changes. `employeeId` is the match key and never changes;
// `permanentTour` has no column.
const FIELD_RULES: readonly FieldRule[] = [
  { key: 'firstName', column: 'first_name', label: 'First name', cell: 'set', show: text },
  { key: 'lastName', column: 'last_name', label: 'Last name', cell: 'set', show: text },
  { key: 'role', column: 'role', label: 'Role', cell: 'set', show: text },
  {
    key: 'employmentType',
    column: 'employment_type',
    label: 'Employment',
    cell: 'set',
    show: (v) => EMPLOYMENT_TYPE_LABELS[v as Nurse['employmentType']],
  },
  { key: 'fte', column: 'fte', label: 'FTE', cell: 'set', show: text },
  {
    key: 'contractedHoursPerPeriod',
    column: 'contracted_hours_per_period',
    label: 'Contracted hours',
    cell: 'set',
    show: text,
  },
  {
    key: 'seniorityDate',
    column: 'seniority_date',
    label: 'Seniority date',
    cell: 'set',
    show: text,
  },
  { key: 'hireDate', column: 'hire_date', label: 'Hire date', cell: 'clear', show: text },
  {
    key: 'scheduleKind',
    column: 'schedule_kind',
    label: 'Schedule plan',
    cell: 'clear',
    show: (v) => SCHEDULE_KIND_LABELS[v as NonNullable<Nurse['scheduleKind']>],
  },
  {
    key: 'scheduledDaysPerWeek',
    column: 'scheduled_days_per_week',
    label: 'Scheduled days per week',
    cell: 'when_filled',
    show: text,
  },
  {
    key: 'isChargeEligible',
    column: 'charge_eligible',
    label: 'Charge eligible',
    cell: 'set',
    show: yesNo,
  },
  { key: 'isNovice', column: 'novice', label: 'New grad', cell: 'set', show: yesNo },
  {
    key: 'isFloatEligible',
    column: 'float_eligible',
    label: 'Float eligible',
    cell: 'set',
    show: yesNo,
  },
  { key: 'phone', column: 'phone', label: 'Phone', cell: 'clear', show: text },
  { key: 'email', column: 'email', label: 'Email', cell: 'clear', show: text },
  { key: 'notes', column: 'notes', label: 'Notes', cell: 'clear', show: text },
];

/** The one employee-id comparison: the plan, the import and the roster editor all use it. */
export function sameEmployeeId(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * How a sheet's employee id finds a stored nurse: trimmed and case-folded, because payroll
 * exports and hand-typed sheets disagree on case and an exact match would create a second
 * person. More than one stored nurse matching is refused, never guessed.
 */
export function matchStoredNurse(
  existing: readonly Nurse[],
  employeeId: string,
): { kind: 'none' } | { kind: 'one'; nurse: Nurse } | { kind: 'ambiguous'; nurses: Nurse[] } {
  const nurses = existing.filter((n) => sameEmployeeId(n.employeeId, employeeId));
  if (nurses.length === 0) return { kind: 'none' };
  if (nurses.length === 1) return { kind: 'one', nurse: nurses[0]! };
  return { kind: 'ambiguous', nurses };
}

type FieldValue = string | number | boolean | null;

/** Only the fields this row would change on `existing`, by the column rules above. */
export function rosterChangesFor(
  existing: Nurse,
  row: RosterCsvRow,
  columns: readonly RosterColumn[],
): RosterNurseUpdate {
  const update: Partial<Record<FieldRule['key'], FieldValue>> = {};
  for (const rule of FIELD_RULES) {
    if (!columns.includes(rule.column)) continue;
    const next = row.nurse[rule.key];
    if (rule.cell === 'when_filled' && next === undefined) continue;
    // Stored `undefined` and an import's `null` both mean "not set": no change between them.
    if ((existing[rule.key] ?? null) === (next ?? null)) continue;
    update[rule.key] = next ?? null;
  }
  return update as RosterNurseUpdate;
}

/** What importing `rows` would do to the unit's nurses (`existing` includes inactive ones). */
export function planRosterImport(
  existing: readonly Nurse[],
  rows: readonly RosterCsvRow[],
  columns: readonly RosterColumn[],
): RosterImportPlanRow[] {
  return rows.map((row) => {
    const { employeeId, firstName, lastName } = row.nurse;
    const name = `${lastName}, ${firstName}`;
    const found = matchStoredNurse(existing, employeeId);
    if (found.kind === 'none') {
      return { employeeId, name, action: 'create', inactive: false, changes: [] };
    }
    if (found.kind === 'ambiguous') {
      return { employeeId, name, action: 'ambiguous', inactive: false, changes: [] };
    }
    const match = found.nurse;

    const update = rosterChangesFor(match, row, columns) as Partial<
      Record<FieldRule['key'], FieldValue>
    >;
    const changes: RosterFieldChange[] = [];
    for (const rule of FIELD_RULES) {
      if (!(rule.key in update)) continue;
      const from = match[rule.key];
      const to = update[rule.key];
      changes.push({
        field: rule.label,
        from: from === undefined ? undefined : rule.show(from),
        to: to === null || to === undefined ? undefined : rule.show(to),
      });
    }
    return {
      employeeId,
      name,
      action: changes.length > 0 ? 'update' : 'unchanged',
      inactive: !match.active,
      changes,
    };
  });
}
