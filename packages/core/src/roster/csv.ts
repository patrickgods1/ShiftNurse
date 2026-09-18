/**
 * Roster CSV: the one parser and one formatter for spreadsheet round-trips.
 *
 * Managers keep the roster in a spreadsheet long before they trust a scheduling tool with
 * it, and they keep exporting to one afterwards for HR. One parser serves both import and
 * export so a file the app wrote is always a file the app can read back — the round-trip
 * test below is the contract. Errors are collected per field with the spreadsheet line
 * number rather than thrown on the first problem: a 60-row import that fails on row 41
 * should tell the manager about rows 41, 52 and 58 in one pass, not three.
 *
 * Lives in core because it is pure text-to-data: no filesystem, no database. The main
 * process reads the file and persists the rows; the eventual web server does the same.
 */

import type { EmploymentType, Nurse, NurseRole } from '../domain/entities.js';
import { type IsoDate, isIsoDate } from '../domain/time.js';

// ---------------------------------------------------------------------------
// Generic CSV (RFC 4180)
// ---------------------------------------------------------------------------

/** Parse CSV text into rows of fields. Handles quoted commas, quotes and newlines, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  // A file that does not end in a newline still has a last row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows as CSV. CRLF line endings, which is what Excel expects. */
export function serializeCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

// ---------------------------------------------------------------------------
// Roster columns
// ---------------------------------------------------------------------------

export const ROSTER_COLUMNS = [
  'employee_id',
  'first_name',
  'last_name',
  'role',
  'employment_type',
  'fte',
  'contracted_hours_per_period',
  'seniority_date',
  'charge_eligible',
  'novice',
  'float_eligible',
  'phone',
  'email',
  'notes',
  'credentials',
] as const;

export type RosterColumn = (typeof ROSTER_COLUMNS)[number];

const REQUIRED_COLUMNS: readonly RosterColumn[] = [
  'employee_id',
  'first_name',
  'last_name',
  'role',
  'employment_type',
  'fte',
  'seniority_date',
];

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'full_time',
  'part_time',
  'per_diem',
  'agency',
];

/** The roster fields a spreadsheet carries: everything on a nurse except identity and unit. */
export type RosterNurseFields = Omit<Nurse, 'id' | 'unitId' | 'active'>;

export interface RosterCredentialField {
  /** Credential code, e.g. `ACLS`. Unknown codes are created on import. */
  code: string;
  expiresOn: IsoDate | undefined;
}

export interface RosterCsvRow {
  nurse: RosterNurseFields;
  credentials: RosterCredentialField[];
}

export interface RosterCsvError {
  /** 1-based line in the file, as a spreadsheet shows it (header is line 1). */
  line: number;
  column: RosterColumn;
  message: string;
}

export interface RosterCsvResult {
  rows: RosterCsvRow[];
  errors: RosterCsvError[];
}

export interface ParseRosterOptions {
  /** Used to derive contracted hours from FTE when the column is blank. */
  payPeriodDays: number;
  /** Hours per week at 1.0 FTE. Default 40. */
  fullTimeHoursPerWeek?: number;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function parseBoolean(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'y':
    case 'yes':
    case 'true':
    case '1':
      return true;
    case '':
    case 'n':
    case 'no':
    case 'false':
    case '0':
      return false;
    default:
      return undefined;
  }
}

function parseCredentials(raw: string): { value: RosterCredentialField[]; error?: string } {
  const value: RosterCredentialField[] = [];
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const [code, expiry, ...rest] = entry.split(':').map((s) => s.trim());
    if (!code || rest.length > 0) return { value, error: `Cannot read credential "${entry}"` };
    if (expiry) {
      if (!isIsoDate(expiry)) {
        return { value, error: `Credential ${code} expiry "${expiry}" is not YYYY-MM-DD` };
      }
      value.push({ code: code.toUpperCase(), expiresOn: expiry });
    } else {
      value.push({ code: code.toUpperCase(), expiresOn: undefined });
    }
  }
  return { value };
}

export function parseRosterCsv(text: string, options: ParseRosterOptions): RosterCsvResult {
  const fullTimeHoursPerWeek = options.fullTimeHoursPerWeek ?? 40;
  const errors: RosterCsvError[] = [];
  const rows: RosterCsvRow[] = [];
  const table = parseCsv(text);
  const header = table[0];
  if (!header)
    return { rows, errors: [{ line: 1, column: 'employee_id', message: 'File is empty' }] };

  const index = new Map<string, number>();
  header.forEach((name, i) => {
    index.set(name.trim().toLowerCase(), i);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    return {
      rows,
      errors: [
        {
          line: 1,
          column: missing[0]!,
          message: `Missing required column(s): ${missing.join(', ')}`,
        },
      ],
    };
  }

  const seen = new Set<string>();

  for (let r = 1; r < table.length; r++) {
    const fields = table[r]!;
    const line = r + 1;
    if (fields.every((f) => f.trim() === '')) continue;
    const cell = (c: RosterColumn): string => {
      const i = index.get(c);
      return i === undefined ? '' : (fields[i] ?? '').trim();
    };
    const rowErrors: RosterCsvError[] = [];
    const bad = (column: RosterColumn, message: string) =>
      rowErrors.push({ line, column, message });

    const employeeId = cell('employee_id');
    if (!employeeId) bad('employee_id', 'Employee id is required');
    else if (seen.has(employeeId)) bad('employee_id', `Duplicate employee id "${employeeId}"`);

    const firstName = cell('first_name');
    const lastName = cell('last_name');
    if (!firstName) bad('first_name', 'First name is required');
    if (!lastName) bad('last_name', 'Last name is required');

    const roleRaw = cell('role').toUpperCase();
    const role = ROLES.find((x) => x === roleRaw);
    if (!role) bad('role', `Unknown role "${cell('role')}" (expected ${ROLES.join(', ')})`);

    const etRaw = cell('employment_type')
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const employmentType = EMPLOYMENT_TYPES.find((x) => x === etRaw);
    if (!employmentType) {
      bad(
        'employment_type',
        `Unknown employment type "${cell('employment_type')}" (expected ${EMPLOYMENT_TYPES.join(', ')})`,
      );
    }

    const fte = Number(cell('fte'));
    if (cell('fte') === '' || Number.isNaN(fte)) bad('fte', `FTE "${cell('fte')}" is not a number`);
    else if (fte < 0 || fte > 1.5) bad('fte', `FTE ${fte} is outside 0–1.5`);

    let contractedHoursPerPeriod: number;
    const hoursRaw = cell('contracted_hours_per_period');
    if (hoursRaw === '') {
      contractedHoursPerPeriod = Math.round(
        fte * fullTimeHoursPerWeek * (options.payPeriodDays / 7),
      );
    } else {
      contractedHoursPerPeriod = Number(hoursRaw);
      if (Number.isNaN(contractedHoursPerPeriod) || contractedHoursPerPeriod < 0) {
        bad('contracted_hours_per_period', `Contracted hours "${hoursRaw}" is not a number`);
      }
    }

    const seniorityRaw = cell('seniority_date');
    if (!isIsoDate(seniorityRaw)) {
      bad('seniority_date', `Seniority date "${seniorityRaw}" is not a valid YYYY-MM-DD date`);
    }

    const flags = {} as Record<'charge_eligible' | 'novice' | 'float_eligible', boolean>;
    for (const column of ['charge_eligible', 'novice', 'float_eligible'] as const) {
      const v = parseBoolean(cell(column));
      if (v === undefined) bad(column, `"${cell(column)}" is not yes/no`);
      flags[column] = v ?? false;
    }

    const credentials = parseCredentials(cell('credentials'));
    if (credentials.error) bad('credentials', credentials.error);

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    seen.add(employeeId);
    rows.push({
      nurse: {
        employeeId,
        firstName,
        lastName,
        role: role!,
        employmentType: employmentType!,
        fte,
        contractedHoursPerPeriod,
        seniorityDate: seniorityRaw as IsoDate,
        isChargeEligible: flags.charge_eligible,
        isNovice: flags.novice,
        isFloatEligible: flags.float_eligible,
        phone: cell('phone') || undefined,
        email: cell('email') || undefined,
        notes: cell('notes') || undefined,
      },
      credentials: credentials.value,
    });
  }

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function formatCredentials(credentials: readonly RosterCredentialField[]): string {
  return credentials.map((c) => (c.expiresOn ? `${c.code}:${c.expiresOn}` : c.code)).join(';');
}

export function formatRosterCsv(rows: readonly RosterCsvRow[]): string {
  const body = rows.map(({ nurse: n, credentials }) => [
    n.employeeId,
    n.firstName,
    n.lastName,
    n.role,
    n.employmentType,
    String(n.fte),
    String(n.contractedHoursPerPeriod),
    n.seniorityDate,
    n.isChargeEligible ? 'yes' : 'no',
    n.isNovice ? 'yes' : 'no',
    n.isFloatEligible ? 'yes' : 'no',
    n.phone ?? '',
    n.email ?? '',
    n.notes ?? '',
    formatCredentials(credentials),
  ]);
  return serializeCsv([ROSTER_COLUMNS, ...body]);
}
