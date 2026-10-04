import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
  testUnit,
} from '../testing/fixtures.js';
import { deriveCounters } from './ledger.js';

beforeEach(() => {
  resetFixtureCounters();
});

describe('nights across the fall-back weekend', () => {
  it('counts the thirteen-hour fall-back night as one night shift', () => {
    const nurse = makeNurse();
    const s = scenario({
      startDate: isoDate('2026-10-25'),
      endDate: isoDate('2026-11-07'),
      nurses: [nurse],
      assignments: [assign(nurse.id, NIGHT_12, '2026-10-31')], // runs into 11-01, the long day
    });
    const counters = deriveCounters(s.schedule, {
      unit: testUnit,
      holidayDates: new Set(),
      weekendDefinition: DEFAULT_WEEKEND,
      preferences: [],
    });
    expect(counters.get(nurse.id)?.nightShifts).toBe(1);
  });
});
