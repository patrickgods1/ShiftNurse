import type { GridSheet, IsoDate, NurseSheet, Unit } from '@shiftnurse/core';
import type { NurseRecord } from '@shiftnurse/db';
import { describe, expect, it } from 'vitest';
import { buildRecordSheet, type RecordSheet, recordCsv } from './nurse-record-sheet.js';
import { gridHtml, nurseSheetsHtml, recordHtml } from './print-html.js';

const unit: Unit = {
  id: 'u1',
  name: '4 West',
  unitType: 'Med-Surg',
  payPeriodDays: 14,
  payPeriodAnchor: '2026-01-04' as never,
};
const nurse = {
  id: 'n1',
  unitId: 'u1',
  employeeId: 'E1',
  firstName: 'Ann',
  lastName: "O'Lee <RN>",
  role: 'RN' as const,
  employmentType: 'full_time' as const,
  fte: 1,
  contractedHoursPerPeriod: 72,
  seniorityDate: '2020-01-01' as never,
  isChargeEligible: true,
  isNovice: false,
  isFloatEligible: true,
  active: true,
};

describe('gridHtml', () => {
  it('stars the charge nurse, shades the weekend and escapes names', () => {
    const sheet: GridSheet = {
      periodName: 'PP1',
      startDate: '2026-01-03' as never,
      endDate: '2026-01-04' as never,
      dates: ['2026-01-03', '2026-01-04'] as never,
      rows: [
        {
          nurse,
          cells: [
            [
              {
                assignmentId: 'a',
                shiftTypeId: 's',
                label: 'D12*',
                isCharge: true,
                isOvertime: false,
              },
            ],
            [],
          ],
          hours: 12,
          onCallHours: 0,
        },
      ],
      dailyCounts: [],
    };
    const html = gridHtml(sheet, { unit, version: undefined, status: 'draft' });
    expect(html).toContain('<span class="charge">D12*</span>');
    expect(html).toContain('<th class="weekend">Sa<br>1/3</th>');
    expect(html).toContain("O'Lee &lt;RN&gt;");
    expect(html).not.toContain('<RN>');
    expect(html).toContain('draft — not yet published');
  });
});

describe('gridHtml inactive nurses', () => {
  it('marks a nurse who left but still holds shifts, and leaves the others plain', () => {
    const row = (n: typeof nurse) => ({ nurse: n, cells: [[], []], hours: 0, onCallHours: 0 });
    const sheet: GridSheet = {
      periodName: 'PP1',
      startDate: '2026-01-03' as never,
      endDate: '2026-01-04' as never,
      dates: ['2026-01-03', '2026-01-04'] as never,
      rows: [
        row({ ...nurse, firstName: 'Gone', lastName: 'Adams', active: false }),
        row({ ...nurse, firstName: 'Stay', lastName: 'Baker' }),
      ],
      dailyCounts: [],
    };
    const html = gridHtml(sheet, { unit, version: undefined, status: 'draft' });
    expect(html).toContain('<td class="name">Adams, Gone (inactive)</td>');
    expect(html).toContain('<td class="name">Baker, Stay</td>');
  });
});

describe('nurseSheetsHtml', () => {
  it('gives each nurse a page that breaks before the next', () => {
    const sheet: NurseSheet = {
      nurse,
      periodName: 'PP1',
      startDate: '2026-01-04' as never,
      endDate: '2026-01-17' as never,
      shifts: [
        {
          assignmentId: 'a',
          date: '2026-01-05' as never,
          weekday: 'Mon',
          label: 'N12',
          shiftTypeName: 'Night 12',
          start: '19:00',
          end: '07:00',
          hours: 12,
          isOnCall: false,
          isCharge: false,
          isOvertime: true,
        },
      ],
      totalHours: 12,
      onCallHours: 0,
      contractedHours: 72,
    };
    const html = nurseSheetsHtml([sheet, sheet], {
      unit,
      version: {
        id: 'v',
        periodId: 'p',
        version: 2,
        publishedAt: 0,
        publishedBy: 'manager',
        assignments: [],
        added: 0,
        removed: 0,
        changed: 0,
      },
      status: 'published',
    });
    expect(html.match(/<section class="page">/g)).toHaveLength(2);
    expect(html).toContain('Mon 1/5');
    expect(html).toContain('19:00–07:00');
    expect(html).toContain('Version 2, published');
    expect(html).toContain('12h scheduled · 72h contracted');
  });
});

describe('dates in the heading', () => {
  const bad = '<b>2026-01-01</b>' as IsoDate;

  it('escapes the dates in the heading, whatever reached the database', () => {
    const record: RecordSheet = {
      nurseName: 'Ann Lee',
      employeeId: 'E1',
      unitName: '4 West',
      start: bad,
      end: '2026-01-31' as IsoDate,
      generatedOn: '2026-02-01' as IsoDate,
      audit: [],
      changes: [],
    };
    const recordPage = recordHtml(record);
    expect(recordPage).toContain('&lt;b&gt;2026-01-01&lt;/b&gt;');
    expect(recordPage).not.toContain('<b>2026-01-01');

    const grid: GridSheet = {
      periodName: 'PP1',
      startDate: bad,
      endDate: '2026-01-04' as IsoDate,
      dates: [],
      rows: [],
      dailyCounts: [],
    };
    const gridPage = gridHtml(grid, { unit, version: undefined, status: 'draft' });
    expect(gridPage).toContain('&lt;b&gt;2026-01-01&lt;/b&gt;');
    expect(gridPage).not.toContain('<b>2026-01-01');
  });
});

describe('paper size', () => {
  const ctx = { unit, version: undefined, status: 'draft' as const };
  const grid: GridSheet = {
    periodName: 'PP1',
    startDate: '2026-01-03' as never,
    endDate: '2026-01-03' as never,
    dates: ['2026-01-03'] as never,
    rows: [],
    dailyCounts: [],
  };
  const nurseSheet: NurseSheet = {
    nurse,
    periodName: 'PP1',
    startDate: '2026-01-04' as never,
    endDate: '2026-01-17' as never,
    shifts: [],
    totalHours: 0,
    onCallHours: 0,
    contractedHours: 72,
  };

  it('lays the grid out on A4 when the unit prints on A4', () => {
    expect(gridHtml(grid, ctx, 'a4')).toContain('@page { size: A4 landscape;');
    expect(nurseSheetsHtml([nurseSheet], ctx, 'a4')).toContain('@page { size: A4 portrait;');
  });

  it('keeps Letter by default', () => {
    expect(gridHtml(grid, ctx)).toContain('@page { size: letter landscape;');
  });
});

describe('how a published shift was changed', () => {
  it('says how a published shift was changed, so a backfill reads as a backfill', () => {
    const record: NurseRecord = {
      nurse,
      start: '2026-01-01' as IsoDate,
      end: '2026-01-31' as IsoDate,
      audit: [],
      scheduleChanges: [
        {
          id: 'c1',
          at: Date.UTC(2026, 0, 10, 12, 0),
          periodId: 'p1',
          periodName: 'PP1',
          kind: 'added',
          source: 'backfill',
          date: '2026-01-12' as IsoDate,
          shiftTypeId: 'st1',
          actor: 'manager',
          reason: 'Covering a call-off',
        },
      ],
    };
    const sheet = buildRecordSheet(
      record,
      unit,
      [{ id: 'st1', abbreviation: 'N' }],
      '2026-02-01' as IsoDate,
    );
    expect(sheet.changes[0]?.how).toBe('call-off backfill');
    expect(recordHtml(sheet)).toContain('<td>call-off backfill</td>');
    expect(recordCsv(sheet)).toContain('by call-off backfill');
  });
});
