import type { Differential, Holiday } from '@shiftnurse/core';
import { isoDate, planHolidayYear } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { applyPlanEdits, describeHolidayPay, lastYearStatus, pairCandidates } from './model.js';

const h = (id: string, date: string, name: string, isMajor: boolean): Holiday => ({
  id,
  unitId: 'u',
  date: isoDate(date),
  name,
  isMajor,
  pairedHolidayId: null,
});

const diff = (kind: Differential['kind'], mode: Differential['mode'], amount: number) => ({
  id: kind,
  unitId: 'u',
  kind,
  mode,
  amount,
  active: true,
});

describe('pairing a minor holiday', () => {
  const holidays = [
    h('xmas', '2026-12-25', 'Christmas Day', true),
    h('ny', '2027-01-01', "New Year's Day", true),
    h('tg', '2026-11-26', 'Thanksgiving Day', true),
    h('mlk', '2027-01-18', 'MLK Day', false),
    h('july', '2026-07-04', 'Independence Day', true),
  ];

  it('offers every major holiday for Christmas Eve, nearest first', () => {
    const eve = h('eve', '2026-12-24', 'Christmas Eve', false);
    // 1 day to Christmas, 8 to New Year's, 28 to Thanksgiving, 173 back to July 4th; MLK Day is
    // not a major holiday, so it is never offered.
    expect(pairCandidates(eve, holidays).map((x) => x.id)).toEqual(['xmas', 'ny', 'tg', 'july']);
  });

  it('offers New Year’s Day for New Year’s Eve across the year end', () => {
    const nye = h('nye', '2026-12-31', "New Year's Eve", false);
    expect(pairCandidates(nye, holidays)[0]?.id).toBe('ny');
  });
});

describe('what a holiday pays', () => {
  it('shows majors and minors apart when a major premium is set', () => {
    expect(
      describeHolidayPay([
        diff('holiday', 'multiplier', 1.5),
        diff('major_holiday', 'multiplier', 2),
      ]),
    ).toEqual({ major: '×2 (major holiday premium)', minor: '×1.5 (holiday premium)' });
  });

  it('says a major holiday falls back to the holiday premium when it has none of its own', () => {
    expect(describeHolidayPay([diff('holiday', 'flat', 5)]).major).toBe(
      '+$5.00/h, the holiday premium (no major premium set)',
    );
  });

  it('says so when nothing is paid for holidays', () => {
    expect(describeHolidayPay([])).toEqual({ major: 'no premium', minor: 'no premium' });
  });
});

describe('reviewing a year of holidays before adding it', () => {
  const source = [
    h('xmas', '2026-12-25', 'Christmas Day', true),
    { ...h('eve', '2026-12-24', 'Christmas Eve', false), pairedHolidayId: 'xmas' },
    h('picnic', '2026-05-08', 'Unit Picnic', false),
  ];
  const plan = planHolidayYear(source, 2027);
  const key = (name: string) => plan.holidays.find((p) => p.name === name)!.key;

  it('adds the list as proposed when nothing is changed', () => {
    const input = applyPlanEdits(plan, {});
    expect(input.holidays.map((r) => r.name)).toEqual([
      'Unit Picnic',
      'Christmas Eve',
      'Christmas Day',
    ]);
    expect(input.holidays.find((r) => r.name === 'Christmas Eve')?.pairWith).toEqual({
      key: key('Christmas Day'),
    });
  });

  it('moves the picnic to the date the manager picks', () => {
    const input = applyPlanEdits(plan, { [key('Unit Picnic')]: { date: isoDate('2027-05-14') } });
    expect(input.holidays.find((r) => r.name === 'Unit Picnic')?.date).toBe('2027-05-14');
  });

  it('unpairs Christmas Eve when Christmas Day is left out', () => {
    const input = applyPlanEdits(plan, { [key('Christmas Day')]: { include: false } });
    expect(input.holidays.map((r) => r.name)).toEqual(['Unit Picnic', 'Christmas Eve']);
    expect(input.holidays[1]?.pairWith).toBeNull();
  });

  it('unpairs Christmas Eve when Christmas Day is made minor', () => {
    const input = applyPlanEdits(plan, { [key('Christmas Day')]: { isMajor: false } });
    expect(input.holidays.find((r) => r.name === 'Christmas Eve')?.pairWith).toBeNull();
  });
});

describe('last year’s holiday on each row', () => {
  const all = [
    h('xmas-25', '2025-12-25', 'Christmas Day', true),
    h('xmas-26', '2026-12-25', 'Christmas Day', true),
    h('xmas-typo', '2026-12-24', 'Xmas Eve', false),
    h('first', '2025-12-24', 'Christmas Eve', false),
  ];

  it('names the holiday it continues', () => {
    expect(lastYearStatus(all[1]!, all)).toEqual({ kind: 'continues', previous: all[0] });
  });

  it('warns when last year has holidays but none by this name', () => {
    expect(lastYearStatus(all[2]!, all)).toEqual({ kind: 'no-match' });
  });

  it('says nothing for the first year on the list', () => {
    expect(lastYearStatus(all[0]!, all)).toEqual({ kind: 'first-year' });
  });

  it('says nothing for Thanksgiving in a list that starts that January', () => {
    // New Year's Day is 329 days before Thanksgiving, but it is the same year's list.
    const firstYear = [
      h('nyd', '2026-01-01', "New Year's Day", true),
      h('tg', '2026-11-26', 'Thanksgiving Day', true),
    ];
    expect(lastYearStatus(firstYear[1]!, firstYear)).toEqual({ kind: 'first-year' });
  });
});
