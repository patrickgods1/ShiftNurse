import type { GridSheet, NurseSheet, Unit } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { gridHtml, nurseSheetsHtml } from './print-html.js';

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
