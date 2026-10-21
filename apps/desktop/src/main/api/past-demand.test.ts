/**
 * A published schedule keeps the staffing verdict of its own days. Tightening a ratio today
 * changes what the coming shifts need; it must not turn last fortnight's fully staffed shifts
 * into shortfalls. The grid, the publish preview and its alerts, the Demand page, Today and the
 * conflict analysis all judge a past date by the demand rules in force when that day ended.
 *
 * Every test also reads the same screen with the clock set back before the fortnight, when none
 * of its days is past and all of them are judged live, so a test cannot pass because the
 * tightening changed nothing.
 */

import { addDays, type IsoDate, type Violation } from '@shiftnurse/core';
import {
  createShiftType,
  listActiveRatioRulesForUnit,
  listPeriodsForUnit,
  loadPeriodInput,
  updateRatioRule,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alertsFor } from './alerts.js';
import { cancellationOrderFor } from './census-cancellation.js';
import { ACTOR, buildConflictInput, scheduleViewFor } from './context.js';
import { dayOfApi } from './dayof.js';
import { censusApi } from './demand.js';
import { publishPreview } from './publish.js';
import { scheduleApi, validateView } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

/** Pins the host clock to `date` at hh:mm local; tests run under TZ=America/New_York. */
function setClock(date: string, hh: number, mm: number) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(y, m - 1, d, hh, mm));
}

let f: Fixture;

beforeEach(() => {
  // The unit's first demand version is recorded as it is seeded, on 1 September; its history
  // runs 23 August to 19 September and the draft starts on the 20th.
  setClock('2026-09-01', 9, 0);
  f = openFixture();
  setClock('2026-09-21', 12, 0);
});

afterEach(() => {
  vi.useRealTimers();
  f.handle.close();
});

/** The published fortnight just before the draft: 6–19 September. */
function lastFortnight() {
  const published = listPeriodsForUnit(f.handle.db, f.seeded.unitId)
    .filter((p) => p.status === 'published')
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
  return published[0]!;
}

/** Thursday 10 September, inside the fortnight. */
const THURSDAY = '2026-09-10' as IsoDate;

/** On 22 September at 10:00 every RN ratio becomes 1:2; the clock then moves to the 25th. */
function tightenRatiosOnThe22nd() {
  setClock('2026-09-22', 10, 0);
  for (const rule of listActiveRatioRulesForUnit(f.handle.db, f.seeded.unitId)) {
    if (rule.role !== 'RN') continue;
    updateRatioRule(f.handle.db, rule.id, { maxPatientsPerNurse: 2 }, ACTOR);
  }
  setClock('2026-09-25', 12, 0);
}

/** `read` as of the 25th, and as of the 5th, when every day of the fortnight is judged live. */
function historicalAndLive<T>(read: () => T): { historical: T; live: T } {
  const historical = read();
  setClock('2026-09-05', 12, 0);
  const live = read();
  setClock('2026-09-25', 12, 0);
  return { historical, live };
}

const STAFFING_RULES = new Set(['patient-ratio-compliance', 'coverage-minimums']);
const staffingBreaks = (violations: readonly Violation[]) =>
  violations.filter((v) => STAFFING_RULES.has(v.ruleId));

describe('a published schedule judged after the ratio is tightened', () => {
  it('keeps last fortnight’s staffing verdict on the grid', () => {
    const period = lastFortnight();
    const judge = () => {
      const { result } = scheduleApi(f.handle.db).validate(period.id);
      return staffingBreaks([...result.hardViolations, ...result.softViolations]);
    };
    const before = judge();
    tightenRatiosOnThe22nd();
    expect(judge()).toEqual(before);
    // Today's 1:2 would call far more of those shifts short: the history is what kept them.
    const { result: live } = validateView(
      f.handle.db,
      period,
      scheduleViewFor(f.handle.db, period, { lookback: true, floated: 'busy' }),
      loadPeriodInput(f.handle.db, period),
    );
    expect(staffingBreaks(live.hardViolations).length).toBeGreaterThan(
      staffingBreaks(before).length,
    );
  });

  it('counts the same hard breaks in the publish preview', () => {
    const period = lastFortnight();
    const before = publishPreview(f.handle.db, period.id).hardViolations;
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(
      () => publishPreview(f.handle.db, period.id).hardViolations,
    );
    expect(historical).toBe(before);
    expect(live).toBeGreaterThan(before);
  });

  it('still warns of the shifts that were staffed exactly at the ratio', () => {
    const period = lastFortnight();
    const atRatio = () =>
      alertsFor(f.handle.db, period.id)
        .filter((a) => a.kind === 'ratio_risk')
        .map((a) => `${a.date} ${a.shiftTypeId}`);
    const before = atRatio();
    expect(before.length).toBeGreaterThan(0);
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(atRatio);
    expect(historical).toEqual(before);
    // Under 1:2 every shift is under its minimum, so none sits exactly at it.
    expect(live).toEqual([]);
  });

  it('shows the Demand page’s past days as they were, and the coming days under the new ratio', () => {
    const period = lastFortnight();
    const rnNeed = (start: IsoDate, end: IsoDate) =>
      censusApi(f.handle.db)
        .demand(f.seeded.unitId, start, end)
        .map((d) => `${d.date} ${d.shiftTypeId} ${d.byRole.RN?.ratioDerived ?? 0}`);
    const later = addDays(f.seeded.draftStart, 10);
    const pastBefore = rnNeed(period.startDate, period.endDate);
    const comingBefore = rnNeed(later, later);
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(() => rnNeed(period.startDate, period.endDate));
    expect(historical).toEqual(pastBefore);
    expect(live).not.toEqual(pastBefore);
    expect(rnNeed(later, later)).not.toEqual(comingBefore);

    // The Thursday day shift's forecast: 9 routine (RN 1:5), 7 moderate (1:4), 3 high (1:2);
    // the charge nurse takes patients and there is no break relief.
    const thursdayDay = (rows: string[]) =>
      rows.find((r) => r.startsWith(`${THURSDAY} ${f.day.id} `))!.split(' ')[2];
    // Then: 9/5 + 7/4 + 3/2 = 1.8 + 1.75 + 1.5 = 5.05, so 6 RNs.
    expect(thursdayDay(historical)).toBe('6');
    // At 1:2 for all 19: 9.5, so 10 RNs.
    expect(thursdayDay(live)).toBe('10');
  });

  it('shows Today’s staffing for a past day as it was required then', () => {
    const required = () =>
      dayOfApi(f.handle.db)
        .today(f.seeded.unitId, THURSDAY)
        .shifts.filter((s) => s.date === THURSDAY)
        .map((s) => `${s.shiftType.id} ${s.staffing.byRole.RN.required}`);
    const before = required();
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(required);
    expect(historical).toEqual(before);
    expect(live).not.toEqual(before);
  });

  it('ranks a past low-census cancellation against what that shift needed then', () => {
    const period = lastFortnight();
    const need = () =>
      cancellationOrderFor(f.handle.db, period.id, THURSDAY, f.day.id, 'RN', []).required;
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(need);
    // The Thursday day shift's actual census: 8 routine (1:5), 6 moderate (1:4), 3 high (1:2).
    // Then: 8/5 + 6/4 + 3/2 = 1.6 + 1.5 + 1.5 = 4.6, so 5 RNs, above Thursday's floor of 4.
    expect(historical).toBe(5);
    // At 1:2 for all 17: 8.5, so 9 RNs.
    expect(live).toBe(9);
  });

  it('analyses conflicts on a past schedule against the demand of its own days', () => {
    const period = lastFortnight();
    const demand = () => buildConflictInput(f.handle.db, period.id).demand;
    const before = demand();
    tightenRatiosOnThe22nd();
    const { historical, live } = historicalAndLive(demand);
    expect(historical).toEqual(before);
    expect(live).not.toEqual(before);
  });
});

describe('a shift type created after a past day', () => {
  /** A twilight shift added on 22 September, then read on the 25th. */
  function addTwilightOnThe22nd() {
    setClock('2026-09-22', 10, 0);
    const twilight = createShiftType(
      f.handle.db,
      {
        unitId: f.seeded.unitId,
        name: 'Twilight',
        abbreviation: 'TW',
        startTime: '15:00',
        durationHours: 8,
        isNight: false,
        isOnCall: false,
        color: '#6366f1',
        sortOrder: 9,
        active: true,
      },
      ACTOR,
    );
    setClock('2026-09-25', 12, 0);
    return twilight;
  }

  it('is not listed on Today for a day before it existed', () => {
    const twilight = addTwilightOnThe22nd();
    const listed = () =>
      dayOfApi(f.handle.db)
        .today(f.seeded.unitId, THURSDAY)
        .shifts.some((s) => s.shiftType.id === twilight.id);
    const { historical, live } = historicalAndLive(listed);
    expect(historical).toBe(false);
    expect(live).toBe(true);
  });

  it('says it was not a shift that day when asked to cancel from it', () => {
    const twilight = addTwilightOnThe22nd();
    expect(() =>
      cancellationOrderFor(f.handle.db, lastFortnight().id, THURSDAY, twilight.id, 'RN', []),
    ).toThrow('Twilight was not an active shift on Thu Sep 10.');
  });
});
