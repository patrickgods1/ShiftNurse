/**
 * Tours on the nurse's plan, by hand. The fixture period runs Sun 4 – Sat 17 Jan 2026: Wed 7,
 * Fri 9, Sat 10 and Sun 11 Jan are the days used below. Day 12 runs 07:00–19:00, Night 12
 * 19:00–07:00 (so Friday's crosses midnight into Saturday), Day 8 07:00–15:00.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, ScheduleKind } from '../domain/entities.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { defaultRuleSet, evaluateSchedule, resolveConfigs } from './registry.js';
import { scheduleKindToursRule } from './schedule-kind-tours.js';

beforeEach(() => resetFixtureCounters());

function judge(scheduleKind: ScheduleKind | undefined, assignments: Assignment[]) {
  const nurse = makeNurse({ id: 'ana', firstName: 'Ana', lastName: 'Cruz', scheduleKind });
  const s = scenario({ nurses: [nurse], assignments });
  return scheduleKindToursRule.evaluate(s.schedule, {}, s.ctx);
}

describe('a nurse on the 72/80 plan', () => {
  it('flags an 8-hour day: the plan is six 12-hour tours', () => {
    const violations = judge('va_72_80', [assign('ana', DAY_8, '2026-01-07', { id: 'd8' })]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: 'off_plan_tour',
      severity: 'hard',
      nurseIds: ['ana'],
      dates: ['2026-01-07'],
      assignmentIds: ['d8'],
    });
    expect(violations[0]!.message).toContain('Ana Cruz');
    expect(violations[0]!.message).toContain('72/80');
    expect(violations[0]!.message).toContain('Wed Jan 7');
  });

  it('allows the 8-hour day when it is recorded as overtime', () => {
    expect(judge('va_72_80', [assign('ana', DAY_8, '2026-01-07', { isOvertime: true })])).toEqual(
      [],
    );
  });

  it('allows 12-hour days and nights on any day of the week', () => {
    expect(
      judge('va_72_80', [
        assign('ana', DAY_12, '2026-01-07'),
        assign('ana', NIGHT_12, '2026-01-09'),
        assign('ana', DAY_12, '2026-01-11'),
      ]),
    ).toEqual([]);
  });
});

describe('a nurse on the Baylor weekend plan', () => {
  it('flags a Wednesday 12: the plan is Friday night to Sunday', () => {
    const violations = judge('va_baylor', [assign('ana', DAY_12, '2026-01-07')]);
    expect(violations.map((v) => v.code)).toEqual(['off_plan_tour']);
    expect(violations[0]!.message).toContain('Baylor');
    expect(violations[0]!.message).toContain('Wed Jan 7');
  });

  it('allows a Saturday day 12 and a Sunday day 12', () => {
    expect(
      judge('va_baylor', [
        assign('ana', DAY_12, '2026-01-10'),
        assign('ana', DAY_12, '2026-01-11'),
      ]),
    ).toEqual([]);
  });

  it('allows the Friday night 12, which runs into Saturday', () => {
    expect(judge('va_baylor', [assign('ana', NIGHT_12, '2026-01-09')])).toEqual([]);
  });

  it('flags the Friday day 12, which ends before the weekend starts', () => {
    expect(judge('va_baylor', [assign('ana', DAY_12, '2026-01-09')]).map((v) => v.code)).toEqual([
      'off_plan_tour',
    ]);
  });

  it('flags a Saturday 8: a Baylor tour is 12 hours', () => {
    expect(judge('va_baylor', [assign('ana', DAY_8, '2026-01-10')]).map((v) => v.code)).toEqual([
      'off_plan_tour',
    ]);
  });

  it('allows a weekday call-in recorded as overtime', () => {
    expect(judge('va_baylor', [assign('ana', DAY_12, '2026-01-07', { isOvertime: true })])).toEqual(
      [],
    );
  });
});

describe('a holdover does not change what tour a shift is', () => {
  // `scheduledHours` is the shift type's declared length; a holdover adds to the worked hours
  // (`paidHours`) and moves the end of the window, never the declared tour.
  it('still flags a 72/80 nurse’s 8 held over four hours: 12 worked, but an 8-hour tour', () => {
    const held = assign('ana', DAY_8, '2026-01-07', {
      id: 'held8',
      holdoverMinutes: 240,
      holdoverMandated: true,
    });
    expect(judge('va_72_80', [held]).map((v) => [v.code, v.assignmentIds])).toEqual([
      ['off_plan_tour', ['held8']],
    ]);
  });

  it('allows a Baylor nurse’s Saturday 12 held over an hour: 13 worked, a 12-hour tour', () => {
    const held = assign('ana', DAY_12, '2026-01-10', {
      holdoverMinutes: 60,
      holdoverMandated: true,
    });
    expect(judge('va_baylor', [held])).toEqual([]);
  });
});

describe('who the rule leaves alone', () => {
  it('never judges a nurse on a standard schedule', () => {
    const shifts = [assign('ana', DAY_8, '2026-01-07'), assign('ana', DAY_12, '2026-01-08')];
    expect(judge(undefined, shifts)).toEqual([]);
    expect(judge('standard', shifts)).toEqual([]);
  });

  it('does not count standby as a tour', () => {
    expect(judge('va_baylor', [assign('ana', ON_CALL, '2026-01-07')])).toEqual([]);
  });

  it('does not flag last schedule’s shifts', () => {
    const nurse = makeNurse({ id: 'ana', scheduleKind: 'va_baylor' });
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [assign('ana', DAY_12, '2025-12-31')],
    });
    expect(scheduleKindToursRule.evaluate(s.schedule, {}, s.ctx)).toEqual([]);
  });

  it('is on and hard in a new rule set, silent for a unit with no plan nurses', () => {
    const config = resolveConfigs(defaultRuleSet('unit-1')).find(
      (c) => c.ruleId === 'schedule-kind-tours',
    );
    expect(config?.enabled).toBe(true);
    expect(scheduleKindToursRule.severity).toBe('hard');
    const s = scenario({
      nurses: [makeNurse({ id: 'ana' })],
      assignments: [assign('ana', DAY_8, '2026-01-07')],
    });
    expect(
      evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
        (v) => v.code === 'off_plan_tour',
      ),
    ).toEqual([]);
  });
});
