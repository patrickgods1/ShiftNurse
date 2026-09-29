import { describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import {
  assign,
  census,
  DAY_12,
  MID_8,
  NIGHT_12,
  ON_CALL,
  TIER_HIGH,
  TIER_ROUTINE,
  testAcuityTiers,
} from '../testing/fixtures.js';
import { deriveDemand } from './demand.js';
import { scheduledHppd } from './hppd.js';

const MONDAY = isoDate('2026-10-05');
const TUESDAY = isoDate('2026-10-06');
const SHIFTS = [DAY_12, NIGHT_12, MID_8, ON_CALL];
const TARGET = { id: 'hppd-1', unitId: 'unit-1', targetHours: 6 };

function demandFor(dates: string[], forecasts: ReturnType<typeof census>[]) {
  return deriveDemand(
    dates.map((d) => isoDate(d)),
    {
      shiftTypes: SHIFTS,
      acuityTiers: testAcuityTiers,
      ratioRules: [],
      coverageRequirements: [],
      censusForecasts: forecasts,
      hppdTarget: TARGET,
    },
  );
}

describe('staff the acuity mix calls for', () => {
  it('asks for about 3.2 nurses on a day 12 with ten routine and four very sick patients', () => {
    // Routine 4h × 10 + high 9h × 4 = 76 care hours a day; the day 12 carries half: 38h,
    // which is 38 / 12 = 3.17 twelve-hour nurses.
    const table = demandFor(
      ['2026-10-05'],
      [census('2026-10-05', DAY_12, { [TIER_ROUTINE.id]: 10, [TIER_HIGH.id]: 4 })],
    );
    expect(table.get(MONDAY, DAY_12.id)?.careHoursRecommendedNurses).toBeCloseTo(38 / 12, 5);
  });

  it('asks for nobody when there is no census forecast for the shift', () => {
    const table = demandFor(['2026-10-05'], []);
    expect(table.get(MONDAY, DAY_12.id)?.careHoursRecommendedNurses).toBe(0);
  });
});

describe('scheduled nursing hours per patient day', () => {
  const twentyAllDay = [
    census('2026-10-05', DAY_12, { [TIER_ROUTINE.id]: 20 }),
    census('2026-10-05', NIGHT_12, { [TIER_ROUTINE.id]: 20 }),
  ];

  it('reads 5.4 with five on days and four on nights for twenty patients', () => {
    // 5 × 12h + 4 × 12h = 108 nursing hours over 20 patient days.
    const assignments = [
      ...['a', 'b', 'c', 'd', 'e'].map((n) => assign(n, DAY_12, '2026-10-05')),
      ...['f', 'g', 'h', 'i'].map((n) => assign(n, NIGHT_12, '2026-10-05')),
    ];
    const report = scheduledHppd({
      dates: [MONDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(['2026-10-05'], twentyAllDay),
      assignments,
      target: TARGET,
    });
    expect(report.nursingHours).toBe(108);
    expect(report.patientDays).toBe(20);
    expect(report.hppd).toBeCloseTo(5.4, 10);
    expect(report.targetHours).toBe(6);
  });

  it('counts a mid shift’s hours but not its census twice', () => {
    // 12 + 12 + 8 = 32 hours; the mid runs inside the day 12, so patient days stay 20.
    const report = scheduledHppd({
      dates: [MONDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(['2026-10-05'], twentyAllDay),
      assignments: [
        assign('a', DAY_12, '2026-10-05'),
        assign('b', NIGHT_12, '2026-10-05'),
        assign('c', MID_8, '2026-10-05'),
      ],
      target: TARGET,
    });
    expect(report.nursingHours).toBe(32);
    expect(report.patientDays).toBe(20);
    expect(report.hppd).toBeCloseTo(1.6, 10);
  });

  it('leaves standby out of the nursing hours', () => {
    const report = scheduledHppd({
      dates: [MONDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(['2026-10-05'], twentyAllDay),
      assignments: [assign('a', DAY_12, '2026-10-05'), assign('b', ON_CALL, '2026-10-05')],
      target: TARGET,
    });
    expect(report.nursingHours).toBe(12);
  });

  it('averages a busy day and a quiet night into the day’s census', () => {
    // 24 patients for the day 12 and 16 for the night 12 is an average of 20 over the day.
    const report = scheduledHppd({
      dates: [MONDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(
        ['2026-10-05'],
        [
          census('2026-10-05', DAY_12, { [TIER_ROUTINE.id]: 24 }),
          census('2026-10-05', NIGHT_12, { [TIER_ROUTINE.id]: 16 }),
        ],
      ),
      assignments: [assign('a', DAY_12, '2026-10-05')],
      target: TARGET,
    });
    expect(report.patientDays).toBe(20);
  });

  it('leaves a day with no census out of the figure and says so', () => {
    const report = scheduledHppd({
      dates: [MONDAY, TUESDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(['2026-10-05', '2026-10-06'], twentyAllDay),
      assignments: [assign('a', DAY_12, '2026-10-05'), assign('b', DAY_12, '2026-10-06')],
      target: TARGET,
    });
    expect(report.nursingHours).toBe(12);
    expect(report.patientDays).toBe(20);
    expect(report.unmeasuredDates).toEqual([TUESDAY]);
    expect(report.days.find((d) => d.date === TUESDAY)?.hppd).toBeUndefined();
  });

  it('has no figure at all when nothing has a census', () => {
    const report = scheduledHppd({
      dates: [MONDAY],
      shiftTypes: SHIFTS,
      demand: demandFor(['2026-10-05'], []),
      assignments: [assign('a', DAY_12, '2026-10-05')],
    });
    expect(report.hppd).toBeUndefined();
    expect(report.targetHours).toBeUndefined();
  });
});
