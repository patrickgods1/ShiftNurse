import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { defaultPeriod } from './default-period.js';

function period(id: string, start: string, status: SchedulePeriod['status']): SchedulePeriod {
  return {
    id,
    unitId: 'u',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(start),
    status,
    ruleSetId: 'r',
    ruleSetVersion: 1,
  } as SchedulePeriod;
}

describe('the period a page lands on', () => {
  it('lands on the draft being built, even when a later schedule is published', () => {
    const draft = period('draft', '2026-10-04', 'draft');
    expect(defaultPeriod([period('pub', '2026-11-01', 'published'), draft])).toBe(draft);
  });

  it('with two drafts, lands on the later one', () => {
    const later = period('later', '2026-11-15', 'draft');
    expect(defaultPeriod([period('earlier', '2026-10-04', 'draft'), later])).toBe(later);
  });

  it('with no draft, lands on the most recent schedule', () => {
    const recent = period('recent', '2026-11-01', 'published');
    expect(defaultPeriod([period('old', '2026-09-01', 'published'), recent])).toBe(recent);
  });

  it('with no schedules, lands nowhere', () => {
    expect(defaultPeriod([])).toBeUndefined();
  });
});
