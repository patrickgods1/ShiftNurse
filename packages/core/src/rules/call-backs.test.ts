/**
 * Time a standby nurse was called back to work counts toward the hour caps (ORS 441.770(3) starts
 * the 12-in-24 count at "a shift or call response"), long stretches and the weekly cap, and toward
 * rest only where the unit says so. Expected values are hand-counted.
 *
 * The fixture: Grace is on call Tue 10 Mar 2026, 19:00 to 07:00. She is called in at 02:00 Wed
 * (420 minutes into the standby) and works 3 hours, to 05:00, then her day 12 runs 07:00–19:00
 * Wed. Clocks sprang forward on Sun 8 Mar, before any of it; no transitions are passed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CallBack } from '../domain/entities.js';
import { isoDate, shiftWindow } from '../domain/time.js';
import { ruleContextForInput } from '../solver/rule-context.js';
import type { SolveCostInput } from '../solver/types.js';
import {
  assign,
  DAY_12,
  makeNurse,
  ON_CALL,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
  solveInputFrom,
  UNIT_ID,
} from '../testing/fixtures.js';
import { maxHoursIn24Rule } from './hours-in-24.js';
import { maxHoursRule } from './hours-rules.js';
import { longStretchRule } from './long-stretch.js';
import { defaultRuleSet, evaluateSchedule, resolveConfigs } from './registry.js';
import { minRestRule } from './rest-rules.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = () =>
  makeNurse({
    id: 'grace',
    firstName: 'Grace',
    lastName: 'Campbell',
    contractedHoursPerPeriod: 120,
  });

const PERIOD = { startDate: isoDate('2026-03-08'), endDate: isoDate('2026-03-21') };

/** Called in `startMinute` minutes into the standby dated `date`, for `hours`. */
function callBack(nurseId: string, date: string, startMinute: number, hours: number): CallBack {
  const start = shiftWindow(isoDate(date), ON_CALL).startMinute + startMinute;
  return { nurseId, window: { startMinute: start, endMinute: start + hours * 60 } };
}

/** The standby, the 02:00–05:00 call-back from it and the Wednesday day 12. */
function wednesday(withCallBack = true) {
  const nurse = grace();
  const standby = assign(nurse.id, ON_CALL, '2026-03-10');
  const day = assign(nurse.id, DAY_12, '2026-03-11');
  const options: ScenarioOptions = {
    ...PERIOD,
    nurses: [nurse],
    assignments: [standby, day],
    ...(withCallBack ? { callBacks: [callBack(nurse.id, '2026-03-10', 420, 3)] } : {}),
  };
  return { nurse, day, options };
}

describe('a call-back and the most hours in any 24', () => {
  it('fits a 3-hour call-back and the day 12 after it under a 16-hour cap: 15 hours', () => {
    const { options } = wednesday();
    const s = scenario(options);
    expect(maxHoursIn24Rule.evaluate(s.schedule, { maxHours: 16 }, s.ctx)).toEqual([]);
  });

  it('flags the same morning under a 12-hour cap, 3 hours over, naming only the day shift', () => {
    const { day, options } = wednesday();
    const s = scenario(options);
    const found = maxHoursIn24Rule.evaluate(s.schedule, { maxHours: 12 }, s.ctx);
    // 02:00–05:00 and 07:00–19:00 fall in the same 24 hours: 3 + 12 = 15h, cap 12.
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'hours_in_24_exceeded',
      amount: 3,
      assignmentIds: [day.id],
      dates: ['2026-03-11'],
      details: { hours: 15, maxHours: 12 },
    });
  });

  it('reads the day 12 alone as 12 hours without the call-back', () => {
    const { options } = wednesday(false);
    const s = scenario(options);
    expect(maxHoursIn24Rule.evaluate(s.schedule, { maxHours: 12 }, s.ctx)).toEqual([]);
  });

  it('never flags a call-back by itself: a finding needs a shift of this schedule', () => {
    const nurse = grace();
    const s = scenario({
      ...PERIOD,
      nurses: [nurse],
      assignments: [assign(nurse.id, ON_CALL, '2026-03-10')],
      callBacks: [callBack(nurse.id, '2026-03-10', 0, 12)],
    });
    expect(maxHoursIn24Rule.evaluate(s.schedule, { maxHours: 8 }, s.ctx)).toEqual([]);
  });
});

describe('a call-back and long stretches of work', () => {
  const judge = (options: ScenarioOptions, bridge: number) => {
    const s = scenario(options);
    return longStretchRule.evaluate(
      s.schedule,
      {
        ...longStretchRule.defaultParams,
        maxConsecutiveHours: 14,
        maxBreakMinutesInStretch: bridge,
      },
      s.ctx,
    );
  };

  it('keeps the call-back apart from the day shift across a 2-hour gap with a 60-minute bridge', () => {
    // 05:00 to 07:00 is 120 minutes: two stretches of 3h and 12h, neither past 14.
    const { options } = wednesday();
    expect(judge(options, 60)).toEqual([]);
  });

  it('joins them into one 15-hour stretch when a 2-hour break does not end one', () => {
    // 3h + 12h worked; the bridged 2 hours are not counted. 15 − 14 = 1 over.
    const { day, options } = wednesday();
    const found = judge(options, 120);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'long_stretch',
      amount: 1,
      assignmentIds: [day.id],
      details: { stretchHours: 15, maxConsecutiveHours: 14, breakMinutes: 120 },
    });
  });

  it('leaves a stretch of last schedule’s day and a call-back alone: nothing in it is this one’s', () => {
    // The same 15 hours, but the schedule starts Thu 12 Mar: the day 12 is the published tail.
    const nurse = grace();
    const found = judge(
      {
        startDate: isoDate('2026-03-12'),
        endDate: isoDate('2026-03-25'),
        nurses: [nurse],
        priorAssignments: [
          assign(nurse.id, ON_CALL, '2026-03-10', { periodId: 'prev' }),
          assign(nurse.id, DAY_12, '2026-03-11', { periodId: 'prev' }),
        ],
        callBacks: [callBack(nurse.id, '2026-03-10', 420, 3)],
      },
      120,
    );
    expect(found).toEqual([]);
  });

  it('flags a call-back 3 hours after a 12-hour stretch that earned 10 off, naming only the stretch', () => {
    // Day 12 Tue 10 Mar 07:00–19:00 earns rest at 12 hours; called in 22:00–01:00 from the
    // standby that began 19:00. 3h off of 10: 7 short.
    const nurse = grace();
    const day = assign(nurse.id, DAY_12, '2026-03-10');
    const s = scenario({
      ...PERIOD,
      nurses: [nurse],
      assignments: [day, assign(nurse.id, ON_CALL, '2026-03-10')],
      callBacks: [callBack(nurse.id, '2026-03-10', 180, 3)],
    });
    const found = longStretchRule.evaluate(
      s.schedule,
      { ...longStretchRule.defaultParams, restAfterHours: 12, restHours: 10 },
      s.ctx,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'rest_after_long_stretch',
      amount: 7,
      assignmentIds: [day.id],
      dates: ['2026-03-10'],
      details: { stretchHours: 12, restHours: 10, hoursOff: 3 },
    });
    expect(found[0]!.message).toContain('before the call-back starting');
  });
});

describe('a call-back and minimum rest', () => {
  const judge = (options: ScenarioOptions, callBackCountsForRest?: boolean) => {
    const s = scenario(options);
    return minRestRule.evaluate(
      s.schedule,
      {
        ...minRestRule.defaultParams,
        minRestHours: 8,
        ...(callBackCountsForRest === undefined ? {} : { callBackCountsForRest }),
      },
      s.ctx,
    );
  };

  it('leaves call-backs out of rest by default, as UC–CNA and WSNA do', () => {
    expect(minRestRule.defaultParams).toMatchObject({ callBackCountsForRest: false });
    const { options } = wednesday();
    expect(judge(options)).toEqual([]);
    expect(judge(options, false)).toEqual([]);
  });

  it('flags a day shift 2 hours after a call-back ends where the unit counts it, 6 hours short', () => {
    // Call-back ends 05:00, the day starts 07:00: 2h off, 8h required.
    const { day, options } = wednesday();
    const found = judge(options, true);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'insufficient_rest',
      amount: 6,
      assignmentIds: [day.id],
      dates: ['2026-03-11'],
      details: { restHours: 2, requiredHours: 8 },
    });
    expect(found[0]!.message).toContain('call-back');
  });

  it('leaves a turnaround from a call-back into last schedule’s shift alone', () => {
    // The same 2 hours, but the day 12 is the published tail of a schedule starting Thu 12 Mar.
    const nurse = grace();
    const found = judge(
      {
        startDate: isoDate('2026-03-12'),
        endDate: isoDate('2026-03-25'),
        nurses: [nurse],
        priorAssignments: [
          assign(nurse.id, ON_CALL, '2026-03-10', { periodId: 'prev' }),
          assign(nurse.id, DAY_12, '2026-03-11', { periodId: 'prev' }),
        ],
        callBacks: [callBack(nurse.id, '2026-03-10', 420, 3)],
      },
      true,
    );
    expect(found).toEqual([]);
  });

  it('reads the setting as off in a stored rule set saved before it existed', () => {
    const stored = defaultRuleSet(UNIT_ID);
    const ruleSet = {
      ...stored,
      configs: stored.configs.map((c) =>
        c.ruleId === minRestRule.id
          ? { ...c, params: { minRestHours: 10, onCallCountsAsWork: false } }
          : c,
      ),
    };
    const rest = resolveConfigs(ruleSet).find((c) => c.ruleId === minRestRule.id)!;
    expect(rest.params).toMatchObject({ minRestHours: 10, callBackCountsForRest: false });
  });
});

describe('a call-back and the weekly hour cap', () => {
  // Weeks start Sunday; 8 Mar and 15 Mar 2026 are Sundays. Four day 12s Mon–Thu are 48h, the cap.
  const fourDays = (nurseId: string) =>
    ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'].map((d) => assign(nurseId, DAY_12, d));
  const pay = (overtimeWindowAttribution?: 'clock' | 'start'): SolveCostInput => ({
    payRates: [],
    differentials: [],
    overtimeRules: [],
    ...(overtimeWindowAttribution ? { overtimeWindowAttribution } : {}),
  });
  const overCap = (options: ScenarioOptions & { cost?: SolveCostInput }) => {
    const s = scenario(options);
    const ctx = ruleContextForInput(solveInputFrom(options));
    return evaluateSchedule(s.schedule, s.ruleSet, ctx).violations.filter(
      (v) => v.code === 'over_max_hours',
    );
  };

  it('adds a 3-hour call-back to its week: 48 + 3 = 51, 3 over the 48 cap', () => {
    const nurse = grace();
    const found = overCap({
      ...PERIOD,
      nurses: [nurse],
      assignments: fourDays(nurse.id),
      // Called in at 23:00 Thursday from a standby that began 19:00, until 02:00 Friday.
      callBacks: [callBack(nurse.id, '2026-03-12', 240, 3)],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ amount: 3, details: { scheduledHours: 51 } });
  });

  it('splits a call-back over the week’s edge by the clock: 1 hour Saturday night, 2 on Sunday', () => {
    // Standby Sat 14 Mar from 19:00, called in at 23:00 until 02:00 Sun 15. By the clock the week
    // of 8 Mar holds 48 + 1 = 49h; whole in its start week (no pay settings, or by start) 51h.
    const options = (cost?: SolveCostInput) => {
      const nurse = grace();
      return {
        ...PERIOD,
        nurses: [nurse],
        assignments: fourDays(nurse.id),
        callBacks: [callBack(nurse.id, '2026-03-14', 240, 3)],
        ...(cost ? { cost } : {}),
      };
    };
    expect(overCap(options(pay('clock'))).map((v) => v.amount)).toEqual([1]);
    expect(overCap(options(pay('start'))).map((v) => v.amount)).toEqual([3]);
    expect(overCap(options()).map((v) => v.amount)).toEqual([3]);
  });

  it('judges no week that holds a call-back and none of this schedule’s shifts', () => {
    // A 3-hour call-back Sun 15 Mar 19:00–22:00 under a 2-hour cap: the week of 15 Mar holds only
    // it. A day 12 that week makes 15h, 13 over.
    const params = { ...maxHoursRule.defaultParams, maxHoursPerWeek: 2, overtimeThresholdHours: 2 };
    const judgeWeek = (withDay: boolean) => {
      const nurse = grace();
      const s = scenario({
        ...PERIOD,
        nurses: [nurse],
        assignments: withDay ? [assign(nurse.id, DAY_12, '2026-03-17')] : [],
        callBacks: [callBack(nurse.id, '2026-03-15', 0, 3)],
      });
      return maxHoursRule.evaluate(s.schedule, params, s.ctx);
    };
    expect(judgeWeek(false)).toEqual([]);
    expect(judgeWeek(true).map((v) => [v.code, v.amount])).toEqual([['over_max_hours', 13]]);
  });

  it('lets a call-back’s own hours past the overtime threshold stand, as a holdover’s do', () => {
    // Mon–Wed 36h and a 6-hour call-back Thursday night: 42h, 2 past the 40h threshold, all of
    // them the call-back's.
    const nurse = grace();
    const s = scenario({
      ...PERIOD,
      nurses: [nurse],
      assignments: fourDays(nurse.id).slice(0, 3),
      callBacks: [callBack(nurse.id, '2026-03-12', 0, 6)],
    });
    const found = maxHoursRule.evaluate(s.schedule, maxHoursRule.defaultParams, s.ctx);
    expect(found).toEqual([]);
  });
});
