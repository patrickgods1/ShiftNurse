/**
 * Writing a period out: PDF grid, PDF nurse sheets, CSV (grid and long form) and xlsx.
 *
 * Everything the file *says* comes from core's projections and `print-html.ts`; this module
 * only owns the Electron parts — the save dialog, the file write, and rendering HTML to PDF
 * through a hidden `BrowserWindow`. Chromium's print engine is used instead of a PDF library
 * because the app already ships it, it handles page breaks and table headers properly, and
 * the same HTML is what a browser-hosted version would print.
 *
 * The hidden window is sandboxed with no preload and loads a `data:` URL, so the document it
 * renders can reach nothing: not the database, not IPC, not the file system.
 */

import { writeFileSync } from 'node:fs';
import type { GridSheet, NurseSheet, ScheduleView } from '@shiftnurse/core';
import {
  buildGridSheet,
  buildNurseSheets,
  formatAssignmentsCsv,
  formatGridCsv,
} from '@shiftnurse/core';
import { BrowserWindow } from 'electron';
import type { OutputFormat } from '../shared/api.js';
import { saveFile } from './native-dialogs.js';
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

/** Render HTML to PDF bytes in a throwaway hidden window. */
export async function htmlToPdf(html: string, landscape: boolean): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      landscape,
      pageSize: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    win.destroy();
  }
}

/** The bytes for any format, with no dialog — what the smoke test and the file export share. */
export async function renderOutput(input: OutputInput, format: OutputFormat): Promise<Buffer> {
  const { schedule, ctx } = input;
  switch (format) {
    case 'pdf-grid':
      return htmlToPdf(gridHtml(buildGridSheet(schedule), ctx), true);
    case 'pdf-nurses':
      return htmlToPdf(nurseSheetsHtml(buildNurseSheets(schedule), ctx), false);
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
  const win = BrowserWindow.getFocusedWindow();
  const options: Electron.SaveDialogOptions = {
    title: `Export ${label}`,
    defaultPath: `${slug(input.ctx.unit.name)}-${slug(period.name)}${version}-${suffix}.${extension}`,
    filters: [{ name: label, extensions: [extension] }],
  };
  const path = await saveFile(win, options);
  if (!path) return undefined;
  writeFileSync(path, await renderOutput(input, format));
  return path;
}
