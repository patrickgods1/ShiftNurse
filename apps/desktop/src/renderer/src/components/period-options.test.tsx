// @vitest-environment jsdom
import { addDays, isoDate, type SchedulePeriod, today } from '@shiftnurse/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PeriodOptions } from './period-options.js';

afterEach(cleanup);

function period(id: string, start: string, end: string, status: SchedulePeriod['status']) {
  return {
    id,
    unitId: 'u',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(end),
    status,
    ruleSetId: 'r',
    ruleSetVersion: 1,
  } as SchedulePeriod;
}

const now = today();
const past = period('past', addDays(now, -20), addDays(now, -1), 'published');
const upcoming = period('upcoming', addDays(now, -5), addDays(now, 30), 'draft');

function groups(periods: SchedulePeriod[]) {
  const { container } = render(
    <select>
      <PeriodOptions periods={periods} />
    </select>,
  );
  return [...container.querySelectorAll('optgroup')].map((g) => ({
    label: g.getAttribute('label'),
    options: [...g.querySelectorAll('option')].map((o) => o.textContent ?? ''),
  }));
}

describe('the period picker', () => {
  it('groups current schedules above past ones and marks drafts', () => {
    const result = groups([past, upcoming]);
    expect(result.map((g) => g.label)).toEqual(['Current and upcoming', 'Past schedules']);
    expect(result[0]!.options).toHaveLength(1);
    expect(result[0]!.options[0]).toContain(' — draft');
    expect(result[1]!.options).toHaveLength(1);
    expect(result[1]!.options[0]).not.toContain('draft');
  });

  it('shows no groups when every schedule is in the past', () => {
    expect(groups([past])).toEqual([]);
  });
});
