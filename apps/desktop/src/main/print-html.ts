/**
 * HTML for the printed outputs: the unit grid and the per-nurse sheets.
 *
 * The projections come from core (`buildGridSheet` / `buildNurseSheets`); this file only
 * decides how they look on paper. It is plain string building, deliberately free of
 * Electron, so the layout can be unit-tested and the same markup could be served to a
 * browser later. The PDF itself is Chromium's print engine via `printToPDF` (see
 * `output.ts`), which is why the CSS uses `@page` and `break-after` rather than anything a
 * PDF library would need.
 *
 * Paper conventions: landscape grid with weekends shaded and the charge nurse starred, one
 * portrait page per nurse with their shifts as a dated list — what a nurse pins to the
 * fridge. Both carry the version number and publish time so a stale printout is
 * identifiable.
 */

import type {
  ComplianceAlert,
  GridSheet,
  NurseSheet,
  ScheduleVersion,
  Unit,
} from '@shiftnurse/core';
import { isWeekendDate, WEEKDAY_NAMES, weekdayOf } from '@shiftnurse/core';

export interface PrintContext {
  unit: Unit;
  version: ScheduleVersion | undefined;
  /** Shown on the grid's cover strip so a printed draft is never mistaken for a promise. */
  status: string;
  alerts?: readonly ComplianceAlert[];
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stamp(ctx: PrintContext): string {
  if (!ctx.version) return `${esc(ctx.status)} — not yet published`;
  const at = new Date(ctx.version.publishedAt).toLocaleString();
  return `Version ${ctx.version.version}, published ${esc(at)}`;
}

function monthDay(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font: 10pt/1.3 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 15pt; margin: 0 0 2pt; }
  .meta { color: #555; font-size: 9pt; margin-bottom: 8pt; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #bbb; padding: 2pt 3pt; text-align: center; vertical-align: middle; }
  th { background: #eee; font-weight: 600; }
  td.name, th.name { text-align: left; white-space: nowrap; }
  .weekend { background: #f3f3f3; }
  .charge { font-weight: 700; }
  .ot { color: #b45309; }
  .legend { margin-top: 6pt; font-size: 8.5pt; color: #333; }
  .legend span { display: inline-block; margin-right: 10pt; }
  .alerts { margin-top: 8pt; font-size: 8.5pt; }
  .alerts li.critical { color: #b91c1c; font-weight: 600; }
`;

export function gridHtml(sheet: GridSheet, ctx: PrintContext): string {
  const head = sheet.dates
    .map((date) => {
      const cls = isWeekendDate(date) ? ' class="weekend"' : '';
      return `<th${cls}>${WEEKDAY_NAMES[weekdayOf(date)].slice(0, 2)}<br>${monthDay(date)}</th>`;
    })
    .join('');
  const rows = sheet.rows
    .map((row) => {
      const cells = row.cells
        .map((cell, i) => {
          const cls = isWeekendDate(sheet.dates[i]!) ? ' class="weekend"' : '';
          const body = cell
            .map(
              (c) =>
                `<span class="${c.isCharge ? 'charge' : ''}${c.isOvertime ? ' ot' : ''}">${esc(c.label)}</span>`,
            )
            .join('<br>');
          return `<td${cls}>${body}</td>`;
        })
        .join('');
      const name = `${row.nurse.lastName}, ${row.nurse.firstName}`;
      return `<tr><td class="name">${esc(name)}</td><td>${esc(row.nurse.role)}</td>${cells}<td>${row.hours}</td></tr>`;
    })
    .join('');
  const footer = sheet.dailyCounts
    .map(
      (dc) =>
        `<tr><th class="name">${esc(dc.shiftType.abbreviation)} on</th><th></th>${dc.counts
          .map((n) => `<th>${n}</th>`)
          .join('')}<th></th></tr>`,
    )
    .join('');
  const legend = sheet.dailyCounts
    .map((dc) => `<span><b>${esc(dc.shiftType.abbreviation)}</b> ${esc(dc.shiftType.name)}</span>`)
    .join('');
  const alerts = ctx.alerts?.length
    ? `<ul class="alerts">${ctx.alerts
        .map((a) => `<li class="${a.severity}">${esc(a.message)}</li>`)
        .join('')}</ul>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sheet.periodName)}</title>
<style>@page { size: letter landscape; margin: 10mm; } ${BASE_CSS} td { font-size: 8.5pt; }</style></head>
<body>
<h1>${esc(ctx.unit.name)} — ${esc(sheet.periodName)}</h1>
<div class="meta">${sheet.startDate} to ${sheet.endDate} · ${stamp(ctx)} · ${sheet.rows.length} nurses</div>
<table><thead><tr><th class="name">Nurse</th><th>Role</th>${head}<th>Hrs</th></tr></thead>
<tbody>${rows}</tbody><tfoot>${footer}</tfoot></table>
<div class="legend">${legend}<span><b>*</b> charge</span><span class="ot"><b>OT</b> authorised overtime</span></div>
${alerts}
</body></html>`;
}

export function nurseSheetsHtml(sheets: readonly NurseSheet[], ctx: PrintContext): string {
  const pages = sheets
    .map((sheet) => {
      const rows = sheet.shifts
        .map(
          (s) =>
            `<tr><td>${esc(s.weekday)} ${monthDay(s.date)}</td><td class="name">${esc(s.shiftTypeName)}${
              s.isCharge ? ' <b>(charge)</b>' : ''
            }${s.isOvertime ? ' <span class="ot">(OT)</span>' : ''}</td><td>${esc(s.start)}–${esc(
              s.end,
            )}</td><td>${s.isOnCall ? 'on call' : `${s.hours}h`}</td><td class="name">${esc(
              s.notes ?? '',
            )}</td></tr>`,
        )
        .join('');
      const name = `${sheet.nurse.firstName} ${sheet.nurse.lastName}`;
      return `<section class="page">
<h1>${esc(name)}</h1>
<div class="meta">${esc(ctx.unit.name)} · ${esc(sheet.periodName)} · ${sheet.startDate} to ${sheet.endDate} · ${stamp(ctx)}</div>
<table><thead><tr><th>Day</th><th class="name">Shift</th><th>Time</th><th>Hours</th><th class="name">Notes</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="meta">${sheet.totalHours}h scheduled${sheet.onCallHours ? ` + ${sheet.onCallHours}h on call` : ''} · ${sheet.contractedHours}h contracted</p>
</section>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nurse sheets</title>
<style>@page { size: letter portrait; margin: 14mm; } ${BASE_CSS} .page { break-after: page; } .page:last-child { break-after: auto; }</style></head>
<body>${pages || '<p class="meta">No nurse has a shift in this period.</p>'}</body></html>`;
}
