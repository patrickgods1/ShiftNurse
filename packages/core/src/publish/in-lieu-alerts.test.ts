/**
 * The in-lieu holiday alert tells the manager a full-time federal nurse's holiday moved to a day
 * she is scheduled. 2026: Mon 5 Jan to Thu 8 Jan worked, Fri 9 Jan the holiday; period Sun 4 Jan
 * to Sat 17 Jan.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Holiday } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
} from '../testing/fixtures.js';
import { type ComplianceInput, complianceAlerts } from './compliance.js';

beforeEach(() => {
  resetFixtureCounters();
});

const holiday = (date: string): Holiday => ({
  id: 'h-1',
  unitId: 'unit-1',
  date: isoDate(date),
  name: 'Epiphany',
  isMajor: true,
  pairedHolidayId: null,
});

const options = (employmentType: 'full_time' | 'part_time' = 'full_time'): ScenarioOptions => ({
  nurses: [makeNurse({ id: 'ada', firstName: 'Ada', lastName: 'Lovelace', employmentType })],
  assignments: ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'].map((d) =>
    assign('ada', DAY_12, d, { id: `a-${d}` }),
  ),
});

function alertsOf(opts: ScenarioOptions, inLieuHolidays?: ComplianceInput['inLieuHolidays']) {
  const s = scenario(opts);
  return complianceAlerts({
    schedule: s.schedule,
    credentials: [],
    nurseCredentials: [],
    demand: [],
    overtimeThresholdHours: 40,
    workWeekStartsOn: 0,
    hoursDriftTolerance: 10,
    payPeriodDays: s.unit.payPeriodDays,
    ...(inLieuHolidays ? { inLieuHolidays } : {}),
  }).filter((a) => a.kind === 'in_lieu_holiday');
}

describe('the in-lieu holiday alert', () => {
  it('tells the manager the Thursday is Ada’s holiday when the holiday is Friday', () => {
    const found = alertsOf(options(), { holidays: [holiday('2026-01-09')], premiumPay: true });
    expect(found).toEqual([
      {
        kind: 'in_lieu_holiday',
        severity: 'information',
        nurseId: 'ada',
        date: '2026-01-08',
        assignmentIds: ['a-2026-01-08'],
        message:
          "Ada Lovelace's in-lieu day for Epiphany is Thu Jan 8: give it off, or it is paid at the holiday rate.",
      },
    ]);
  });

  it('asks how the day is compensated when the unit pays no holiday premium', () => {
    const found = alertsOf(options(), { holidays: [holiday('2026-01-09')], premiumPay: false });
    expect(found[0]!.message).toBe(
      "Ada Lovelace's in-lieu day for Epiphany is Thu Jan 8: give it off, or record how it is compensated.",
    );
  });

  it('says nothing when the unit does not use in-lieu holidays', () => {
    expect(alertsOf(options())).toEqual([]);
  });

  it('does not judge a holiday outside the period', () => {
    // Fri 23 Jan is past the period's last day, Sat 17 Jan.
    expect(alertsOf(options(), { holidays: [holiday('2026-01-23')], premiumPay: true })).toEqual(
      [],
    );
  });

  it('says nothing about a part-time nurse', () => {
    expect(
      alertsOf(options('part_time'), { holidays: [holiday('2026-01-09')], premiumPay: true }),
    ).toEqual([]);
  });

  it('says nothing about a nurse who has left the unit', () => {
    const opts = options();
    opts.nurses = [{ ...opts.nurses![0]!, active: false }];
    expect(alertsOf(opts, { holidays: [holiday('2026-01-09')], premiumPay: true })).toEqual([]);
  });
});
