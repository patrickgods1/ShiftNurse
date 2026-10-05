/**
 * A nurse's record for a grievance, built from the audit log and the published-schedule change
 * log. Pure of Electron: the save dialog and the PDF window are in `files.ts`, so what the file
 * says can be tested under plain Node.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { type DbLike, listShiftTypesForUnit, nurseRecord } from '@shiftnurse/db';
import { buildRecordSheet, type RecordSheet, recordCsv } from '../nurse-record-sheet.js';
import { recordHtml } from '../print-html.js';
import { unitOrThrow } from './context.js';

export interface NurseRecordDocument {
  sheet: RecordSheet;
  csv: string;
  html: string;
  /** A file name without its extension: nurse, then the dates. */
  baseName: string;
}

const slug = (text: string) => text.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');

export function nurseRecordDocument(
  db: DbLike,
  nurseId: Id,
  start: IsoDate,
  end: IsoDate,
  generatedOn: IsoDate,
): NurseRecordDocument {
  const record = nurseRecord(db, nurseId, start, end);
  const unit = unitOrThrow(db, record.nurse.unitId);
  const sheet = buildRecordSheet(record, unit, listShiftTypesForUnit(db, unit.id), generatedOn);
  return {
    sheet,
    csv: recordCsv(sheet),
    html: recordHtml(sheet),
    baseName: `${slug(`${record.nurse.lastName}-${record.nurse.firstName}`)}-record-${start}-to-${end}`,
  };
}
