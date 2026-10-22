/**
 * Two alerts that tell payroll where the app's weekly count and the law's can part: the week a
 * work-week start changes (29 CFR 778.302: the overlapping hours count toward whichever week pays
 * more) and pay that credits a night to the week it starts in (DOL opinion letter FLSA2005-17:
 * lawful only if it never pays less than counting each hour where it was worked). Hours are
 * hand-counted against the max-hours rule's 40h threshold. 2026-01-03, -10 and -17 are Saturdays.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CostContext } from '../cost/types.js';
import { DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
} from '../testing/fixtures.js';
import { type ComplianceInput, complianceAlerts } from './compliance.js';

beforeEach(() => {
  resetFixtureCounters();
});

const ada = () => makeNurse({ id: 'ada', firstName: 'Ada', lastName: 'Lovelace' });

/** Pay settings with no overtime rules: only the attribution matters here. */
const pay = (s: ReturnType<typeof scenario>, attribution: 'clock' | 'start'): CostContext => ({
  unit: s.unit,
  payRates: [],
  differentials: [],
  overtimeRules: [],
  holidayDates: new Set(),
  weekendDefinition: DEFAULT_WEEKEND,
  workWeekStartsOn: 0,
  overtimeWindowAttribution: attribution,
});

function alertsOf(
  options: ScenarioOptions,
  kind: string,
  extra: (s: ReturnType<typeof scenario>) => Partial<ComplianceInput>,
) {
  const s = scenario(options);
  return complianceAlerts({
    schedule: s.schedule,
    credentials: [],
    nurseCredentials: [],
    demand: [],
    overtimeThresholdHours: 40,
    workWeekStartsOn: 0,
    hoursDriftTolerance: 10,
    payPeriodDays: s.unit.payPeriodDays,
    ...extra(s),
  }).filter((a) => a.kind === kind);
}

describe('the week the work-week start changes (29 CFR 778.302)', () => {
  // The last schedule was published under a Sunday 00:00 week; this one opens on Sat 10 Jan under
  // a Saturday 19:00 week. The published Sun–Tue 4–6 Jan 12s are 36h of the old week Sun 4 –
  // Sat 10 Jan, and of the new week from Sat 3 Jan 19:00 to Sat 10 Jan 19:00.
  const SAT_19 = { workWeekStartsOn: 6, workWeekStartMinute: 1140 } as const;
  const options = (shift: typeof DAY_12): ScenarioOptions => ({
    startDate: isoDate('2026-01-10'),
    endDate: isoDate('2026-01-23'),
    nurses: [ada()],
    priorAssignments: ['2026-01-04', '2026-01-05', '2026-01-06'].map((d) =>
      assign('ada', DAY_12, d, { periodId: 'prev' }),
    ),
    assignments: [assign('ada', shift, '2026-01-10')],
  });
  const changed = (s: ReturnType<typeof scenario>): Partial<ComplianceInput> => ({
    ...SAT_19,
    previousWorkWeek: { workWeekStartsOn: 0, workWeekStartMinute: 0 },
    cost: pay(s, 'clock'),
  });

  it('tells payroll when the old week holds more overtime than the new one', () => {
    // Sat 10 Jan night, 19:00–07:00. Old way, by the clock: 36 + 19:00–24:00 (5) = 41h, 1 over.
    // New way: the night starts on the new boundary and belongs to the next week: 36h, 0 over.
    const found = alertsOf(options(NIGHT_12), 'work_week_changeover', changed);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nurseId: 'ada', date: '2026-01-03', overtimeHours: 1 });
    expect(found[0]!.message).toBe(
      'The work week changed from Sunday 00:00 to Saturday 19:00. For the week of Sat Jan 3, ' +
        'Ada Lovelace has 1h of overtime counted the old way and 0h the new way; payroll owes ' +
        'the greater (29 CFR 778.302).',
    );
  });

  it('says nothing when the new week counts at least as much overtime', () => {
    // Sat 10 Jan 07:00–19:00 day. Old way: 36 + 12 = 48h, 8 over. New way: it starts before
    // 19:00, so the week from Sat 3 Jan holds 36 + 12 = 48h too, 8 over.
    expect(alertsOf(options(DAY_12), 'work_week_changeover', changed)).toEqual([]);
  });

  it('says nothing when the work week did not change', () => {
    const same = (s: ReturnType<typeof scenario>): Partial<ComplianceInput> => ({
      ...SAT_19,
      previousWorkWeek: SAT_19,
      cost: pay(s, 'clock'),
    });
    expect(alertsOf(options(NIGHT_12), 'work_week_changeover', same)).toEqual([]);
    const none = (s: ReturnType<typeof scenario>) => ({ ...SAT_19, cost: pay(s, 'clock') });
    expect(alertsOf(options(NIGHT_12), 'work_week_changeover', none)).toEqual([]);
  });

  it('judges a day nurse by the unit week when only the night nurses’ week was added', () => {
    // The night week is new, but Ada is not on permanent nights: her week did not move.
    const nightOnly = (s: ReturnType<typeof scenario>): Partial<ComplianceInput> => ({
      workWeekStartsOn: 0,
      nightWorkWeekStartsOn: 6,
      nightWorkWeekStartMinute: 1140,
      previousWorkWeek: { workWeekStartsOn: 0 },
      cost: pay(s, 'clock'),
    });
    expect(alertsOf(options(NIGHT_12), 'work_week_changeover', nightOnly)).toEqual([]);
  });
});

describe('the changeover with overtime judged by the pay period', () => {
  // 8/80 over the pay period Sun 4 – Sat 17 Jan; the schedule opens Wed 7 Jan, inside it. The last
  // schedule published the Sat 3 Jan night (19:00–07:00) and Mon–Tue 5–6 Jan 12s; this one has
  // Wed 7 Jan and Mon–Thu 12–15 Jan 12s.
  //   Pay period from midnight: the night's Sunday 00:00–07:00 (7) + 24 + 12 + 48 = 91h, 11 over.
  //   From 07:00: the night ends on the boundary, so 24 + 12 + 48 = 84h, 4 over.
  const options = (permanentTour?: 'night'): ScenarioOptions => ({
    startDate: isoDate('2026-01-07'),
    endDate: isoDate('2026-01-20'),
    nurses: [
      makeNurse({
        id: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        ...(permanentTour ? { permanentTour } : {}),
      }),
    ],
    priorAssignments: [
      assign('ada', NIGHT_12, '2026-01-03', { periodId: 'prev' }),
      ...['2026-01-05', '2026-01-06'].map((d) => assign('ada', DAY_12, d, { periodId: 'prev' })),
    ],
    assignments: ['2026-01-07', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15'].map((d) =>
      assign('ada', DAY_12, d),
    ),
  });
  const byPayPeriod = (
    s: ReturnType<typeof scenario>,
    weeks: Partial<ComplianceInput>,
  ): Partial<ComplianceInput> => ({
    workWeekStartsOn: 0,
    ...weeks,
    payPeriodOvertime: { thresholdHours: 80, payPeriodAnchor: s.unit.payPeriodAnchor },
    cost: pay(s, 'clock'),
  });

  it('tells payroll when moving the start time moves overtime out of the pay period', () => {
    const found = alertsOf(options(), 'work_week_changeover', (s) =>
      byPayPeriod(s, {
        workWeekStartMinute: 420,
        previousWorkWeek: { workWeekStartsOn: 0, workWeekStartMinute: 0 },
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ date: '2026-01-04', overtimeHours: 11 });
    expect(found[0]!.message).toBe(
      'The work week changed from Sunday 00:00 to Sunday 07:00. For the pay period from Sun ' +
        'Jan 4, Ada Lovelace has 11h of overtime counted the old way and 4h the new way; ' +
        'payroll owes the greater (29 CFR 778.302).',
    );
  });

  it('says nothing when only the weekday changed, since a pay period keeps its dates', () => {
    // The unit's week moves from Sunday to Wednesday at midnight: the pay period is the same.
    expect(
      alertsOf(options(), 'work_week_changeover', (s) =>
        byPayPeriod(s, {
          workWeekStartsOn: 3,
          previousWorkWeek: { workWeekStartsOn: 0, workWeekStartMinute: 0 },
        }),
      ),
    ).toEqual([]);
    // The night nurses' week moves from Saturday to Wednesday, at midnight both times.
    expect(
      alertsOf(options('night'), 'work_week_changeover', (s) =>
        byPayPeriod(s, {
          nightWorkWeekStartsOn: 3,
          previousWorkWeek: { workWeekStartsOn: 0, nightWorkWeekStartsOn: 6 },
        }),
      ),
    ).toEqual([]);
  });
});

describe('pay that credits a night to the week it starts in (FLSA2005-17)', () => {
  // Week from Sunday 00:00. Wed–Fri 7–9 Jan 12s (36h), the Sat 10 Jan night 19:00–07:00, then
  // Sun–Tue 11–13 Jan 12s (36h).
  //   By start: week of 4 Jan = 36 + 12 = 48h (8 over); week of 11 Jan = 36h (0 over).
  //   By the clock: week of 4 Jan = 36 + 5 = 41h (1 over); week of 11 Jan = 7 + 36 = 43h (3 over).
  // Start pays 8 overall against the clock's 4, but the week of 11 Jan is 3h short of the clock.
  const options: ScenarioOptions = {
    nurses: [ada()],
    assignments: [
      ...['2026-01-07', '2026-01-08', '2026-01-09'].map((d) => assign('ada', DAY_12, d)),
      assign('ada', NIGHT_12, '2026-01-10'),
      ...['2026-01-11', '2026-01-12', '2026-01-13'].map((d) => assign('ada', DAY_12, d)),
    ],
  };

  it('flags the week the clock counts more overtime than pay credits', () => {
    const found = alertsOf(options, 'start_attribution_underpays', (s) => ({
      cost: pay(s, 'start'),
    }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nurseId: 'ada', date: '2026-01-11', overtimeHours: 3 });
    expect(found[0]!.message).toBe(
      'Pay credits a night to the week it starts in. Counted by the clock, Ada Lovelace works ' +
        '3h of overtime in the week of Sun Jan 11, 3h more than pay credits. The Labor ' +
        'Department allows start-week crediting only if it never pays less (opinion letter ' +
        'FLSA2005-17).',
    );
  });

  it('says nothing when pay counts by the clock, or no pay settings are loaded', () => {
    expect(
      alertsOf(options, 'start_attribution_underpays', (s) => ({ cost: pay(s, 'clock') })),
    ).toEqual([]);
    expect(alertsOf(options, 'start_attribution_underpays', () => ({}))).toEqual([]);
  });
});
