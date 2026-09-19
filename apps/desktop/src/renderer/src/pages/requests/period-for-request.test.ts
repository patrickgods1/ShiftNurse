import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { describe, expect, it } from 'vitest';
import { periodForRequest } from './period-for-request.js';

function period(id: string, start: string, end: string, status: SchedulePeriod['status']) {
  return {
    id,
    unitId: 'u',
    name: id,
    startDate: isoDate(start),
    endDate: isoDate(end),
    status,
    ruleSetId: 'rs',
    ruleSetVersion: 1,
  } as SchedulePeriod;
}

const published = period('sep', '2026-09-06', '2026-09-19', 'published');
const draft = period('oct', '2026-09-20', '2026-10-03', 'draft');

describe('periodForRequest', () => {
  it('returns nothing for leave in a month no schedule covers yet', () => {
    const r = periodForRequest([published, draft], {
      startDate: isoDate('2026-12-24'),
      endDate: isoDate('2026-12-26'),
    });
    expect(r).toBeUndefined();
  });

  it('picks the period containing the request', () => {
    const r = periodForRequest([published, draft], {
      startDate: isoDate('2026-09-10'),
      endDate: isoDate('2026-09-11'),
    });
    expect(r?.id).toBe('sep');
  });

  it('prefers the draft when a request straddles a published/draft boundary', () => {
    const r = periodForRequest([published, draft], {
      startDate: isoDate('2026-09-18'),
      endDate: isoDate('2026-09-21'),
    });
    expect(r?.id).toBe('oct');
  });
});
