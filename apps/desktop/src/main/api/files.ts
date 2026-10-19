/**
 * The handlers that start with a native file dialog: roster import/export and the historical
 * schedule import. Electron's dialogs are reached only through `native-dialogs.ts`; what they do
 * with the file once chosen is plain repository and core calls.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
  formatRosterCsv,
  groupIntoPayPeriods,
  type Id,
  type IsoDate,
  parseHistoricalScheduleCsv,
  parseRosterCsv,
  planRosterImport,
  today,
} from '@shiftnurse/core';
import {
  type DbLike,
  exportRoster,
  ledgerPeriodsForUnit,
  listNursesForUnit,
  listShiftTypesForUnit,
} from '@shiftnurse/db';
import type {
  HistoryImportPreview,
  NurseRecordFormat,
  RosterImportPreview,
} from '../../shared/api.js';
import { openFile, saveFile } from '../native-dialogs.js';
import { htmlToPdf, osPaperSize } from '../output.js';

import { unitOrThrow } from './context.js';
import { nurseRecordDocument } from './nurse-record.js';

export async function pickRosterImportFile(
  db: DbLike,
  unitId: Id,
): Promise<RosterImportPreview | undefined> {
  const unit = unitOrThrow(db, unitId);
  const path = await openFile({
    title: 'Import roster',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (!path) return undefined;
  const text = readFileSync(path, 'utf8');
  const { rows, errors, columns } = parseRosterCsv(text, { payPeriodDays: unit.payPeriodDays });
  // Inactive nurses are included: the plan has to say who a re-import would bring back.
  const plan = planRosterImport(listNursesForUnit(db, unitId), rows, columns);
  return { path, rows, errors, columns, plan };
}

export async function exportRosterToFile(db: DbLike, unitId: Id): Promise<string | undefined> {
  const unit = unitOrThrow(db, unitId);
  const path = await saveFile({
    title: 'Export roster',
    defaultPath: `${unit.name.replace(/[^\w-]+/g, '_')}-roster-${today()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (!path) return undefined;
  writeFileSync(path, formatRosterCsv(exportRoster(db, unitId)), 'utf8');
  return path;
}

export async function pickHistoryImportFile(
  db: DbLike,
  unitId: Id,
): Promise<HistoryImportPreview | undefined> {
  const unit = unitOrThrow(db, unitId);
  const path = await openFile({
    title: 'Import historical schedule',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (!path) return undefined;
  const text = readFileSync(path, 'utf8');
  const { rows, errors } = parseHistoricalScheduleCsv(text, {
    nurses: listNursesForUnit(db, unitId),
    shiftTypes: listShiftTypesForUnit(db, unitId),
  });
  const existing = new Set(ledgerPeriodsForUnit(db, unitId).map((p) => p.periodId));
  const periods = groupIntoPayPeriods(rows, unit).map((p) => ({
    periodId: p.periodId,
    start: p.start,
    end: p.end,
    shifts: p.rows.length,
    nurses: new Set(p.rows.map((r) => r.employeeId)).size,
    replacesExisting: existing.has(p.periodId),
  }));
  return { path, rows, errors, periods };
}

/** The nurse's record in the range, to a file the manager picks; undefined when they cancel. */
export async function exportNurseRecordToFile(
  db: DbLike,
  nurseId: Id,
  start: IsoDate,
  end: IsoDate,
  format: NurseRecordFormat,
): Promise<string | undefined> {
  // Built before the dialog so a refusal (a range backwards, an unknown nurse) shows first.
  const doc = nurseRecordDocument(db, nurseId, start, end, today(), osPaperSize());
  const extension = format === 'pdf' ? 'pdf' : 'csv';
  const path = await saveFile({
    title: `Export nurse record (${extension.toUpperCase()})`,
    defaultPath: `${doc.baseName}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!path) return undefined;
  if (format === 'pdf') writeFileSync(path, await htmlToPdf(doc.html, false, doc.paper));
  else writeFileSync(path, doc.csv, 'utf8');
  return path;
}
