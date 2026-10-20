/**
 * Writing a period out: PDF grid, PDF nurse sheets, CSV (grid and long form) and xlsx.
 *
 * Everything the file *says* comes from core's projections and `print-html.ts`; this module
 * only owns the Electron parts — the save dialog, the file write, and rendering HTML to PDF
 * through a hidden `BrowserWindow`. Chromium's print engine is used instead of a PDF library
 * because the app already ships it, it handles page breaks and table headers properly, and
 * the same HTML is what a browser-hosted version would print.
 *
 * The hidden window is sandboxed with no preload, has JavaScript off, and loads the document
 * from a private temp file, so what it renders can reach nothing: not the database, not IPC,
 * not the file system. A file rather than a `data:` URL because a `data:` URL fails past about
 * 1-2 MB (a long nurse record crosses that) and its error message would carry the document's
 * head, nurse name and employee id included, into the log and the dialog.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GridSheet, NurseSheet, PaperSize, ScheduleView } from '@shiftnurse/core';
import {
  buildGridSheet,
  buildNurseSheets,
  formatAssignmentsCsv,
  formatGridCsv,
} from '@shiftnurse/core';
import { app, BrowserWindow } from 'electron';
import type { OutputFormat } from '../shared/api.js';
import { saveFile } from './native-dialogs.js';
import { paperForRegion, pdfPageSize } from './paper.js';
import { gridHtml, nurseSheetsHtml, type PrintContext } from './print-html.js';
import { buildXlsx } from './xlsx.js';

export interface OutputInput {
  schedule: ScheduleView;
  ctx: PrintContext;
}

const FORMATS: Record<OutputFormat, { label: string; extension: string }> = {
  'pdf-grid': { label: 'Schedule grid (PDF)', extension: 'pdf' },
  'pdf-nurses': { label: 'Per-nurse sheets (PDF)', extension: 'pdf' },
  'csv-grid': { label: 'Schedule grid (CSV)', extension: 'csv' },
  'csv-long': { label: 'Shift list (CSV)', extension: 'csv' },
  xlsx: { label: 'Excel workbook', extension: 'xlsx' },
};

function slug(text: string): string {
  return text.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
}

export function renderCsv(schedule: ScheduleView, format: 'csv-grid' | 'csv-long'): string {
  return format === 'csv-grid'
    ? formatGridCsv(buildGridSheet(schedule))
    : formatAssignmentsCsv(schedule);
}

/** The grid and the long shift list on two sheets: the grid to read, the list to pivot. */
function workbook(grid: GridSheet, sheets: readonly NurseSheet[]): Buffer {
  const gridRows = [
    ['employee_id', 'name', 'role', ...grid.dates, 'hours', 'on_call_hours'],
    ...grid.rows.map((row) => [
      row.nurse.employeeId,
      `${row.nurse.lastName}, ${row.nurse.firstName}`,
      row.nurse.role,
      ...row.cells.map((cell) => cell.map((c) => c.label).join(' ')),
      row.hours,
      row.onCallHours,
    ]),
  ];
  const shiftRows = [
    [
      'employee_id',
      'name',
      'date',
      'weekday',
      'shift',
      'start',
      'end',
      'hours',
      'charge',
      'overtime',
    ],
    ...sheets.flatMap((s) =>
      s.shifts.map((sh) => [
        s.nurse.employeeId,
        `${s.nurse.lastName}, ${s.nurse.firstName}`,
        sh.date,
        sh.weekday,
        sh.label,
        sh.start,
        sh.end,
        sh.isOnCall ? 0 : sh.hours,
        sh.isCharge ? 'yes' : '',
        sh.isOvertime ? 'yes' : '',
      ]),
    ),
  ];
  return buildXlsx([
    { name: 'Grid', rows: gridRows },
    { name: 'Shifts', rows: shiftRows },
  ]);
}

/** Where print jobs stage their HTML: inside userData, which already holds this data. */
export function printScratchDir(): string {
  const dir = join(app.getPath('userData'), 'print');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Start-up sweep: a crash mid-print must not leave nurse data on disk past the next launch. */
export function clearPrintScratch(): void {
  try {
    rmSync(join(app.getPath('userData'), 'print'), { recursive: true, force: true });
  } catch (err) {
    console.error(`[output] clearing print files failed (${errorCode(err)})`);
  }
}

// Only a code or a name: the message of a load failure can quote the document.
function errorCode(err: unknown): string {
  return (err as { code?: string }).code ?? (err as Error).name ?? 'unknown';
}

/** What this computer's region prints on; a unit with no paper size of its own uses it. */
export function osPaperSize(): PaperSize {
  return paperForRegion(app.getLocaleCountryCode());
}

/** Render HTML to PDF bytes in a throwaway hidden window. */
export async function htmlToPdf(
  html: string,
  landscape: boolean,
  paper: PaperSize,
): Promise<Buffer> {
  // Inside the try: a full disk or a locked userData would otherwise surface its own message,
  // with the folder's path, instead of the fixed words below.
  let dir: string | undefined;
  let win: BrowserWindow | undefined;
  try {
    dir = mkdtempSync(join(printScratchDir(), 'job-'));
    const file = join(dir, 'document.html');
    writeFileSync(file, html, { encoding: 'utf8', mode: 0o600 });
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    await win.loadFile(file);
    return await win.webContents.printToPDF({
      landscape,
      pageSize: pdfPageSize(paper),
      printBackground: true,
      preferCSSPageSize: true,
    });
  } catch (err) {
    console.error(`[output] PDF rendering failed (${errorCode(err)})`);
    throw new Error(
      'The PDF could not be produced. Try a shorter date range, or export CSV instead.',
    );
  } finally {
    try {
      win?.destroy();
    } catch {
      // Nothing useful to say; the folder removal below still has to run.
    }
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[output] removing print file failed (${errorCode(err)})`);
      }
    }
  }
}

/** The bytes for any format, with no dialog — what the smoke test and the file export share. */
export async function renderOutput(input: OutputInput, format: OutputFormat): Promise<Buffer> {
  const { schedule, ctx } = input;
  const paper = ctx.unit.paperSize ?? osPaperSize();
  switch (format) {
    case 'pdf-grid':
      return htmlToPdf(gridHtml(buildGridSheet(schedule), ctx, paper), true, paper);
    case 'pdf-nurses':
      return htmlToPdf(nurseSheetsHtml(buildNurseSheets(schedule), ctx, paper), false, paper);
    case 'csv-grid':
    case 'csv-long':
      return Buffer.from(renderCsv(schedule, format), 'utf8');
    case 'xlsx':
      return workbook(buildGridSheet(schedule), buildNurseSheets(schedule));
  }
}

export async function exportToFile(
  input: OutputInput,
  format: OutputFormat,
): Promise<string | undefined> {
  const { label, extension } = FORMATS[format];
  const period = input.schedule.period;
  const suffix =
    format === 'pdf-nurses' ? 'nurse-sheets' : format === 'csv-long' ? 'shifts' : 'grid';
  const version = input.ctx.version ? `-v${input.ctx.version.version}` : '';
  const options: Electron.SaveDialogOptions = {
    title: `Export ${label}`,
    defaultPath: `${slug(input.ctx.unit.name)}-${slug(period.name)}${version}-${suffix}.${extension}`,
    filters: [{ name: label, extensions: [extension] }],
  };
  const path = await saveFile(options);
  if (!path) return undefined;
  writeFileSync(path, await renderOutput(input, format));
  return path;
}
