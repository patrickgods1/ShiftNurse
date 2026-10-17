/**
 * A recorded holdover is the manager signing off the time it adds, and nothing more. When it
 * excused the whole week, a quarter hour held over on Sunday let four unauthorised hours through
 * on Thursday, and CP-SAT (which never read holdovers) disagreed with the rule about the same
 * week. These pin what a holdover does and does not authorise.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_8,
  DAY_12,
  makeNurse,
  ON_CALL,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
} from '../testing/fixtures.js';
import { maxHoursRule, overtimeHoursAround } from './hours-rules.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

// A 120h contract keeps the FTE rule quiet, so only the overtime check speaks.
const ada = () => makeNurse({ id: 'ada', firstName: 'Ada', contractedHoursPerPeriod: 120 });

function unauthorised(options: ScenarioOptions) {
  const s = scenario(options);
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'unauthorised_overtime',
  );
}

describe('what a recorded holdover authorises', () => {
  it('authorises only the quarter hour a holdover adds, not the rest of the week', () => {
    // Worked 12.25 + 12 + 12 + 8 = 44.25h in the week of Sun 4 Jan; 44.25 − 40 − 0.25 = 4h
    // nobody authorised.
    const found = unauthorised({
      nurses: [ada()],
      assignments: [
        assign('ada', DAY_12, '2026-01-04', { holdoverMinutes: 15, holdoverMandated: true }),
        assign('ada', DAY_12, '2026-01-05'),
        assign('ada', DAY_12, '2026-01-06'),
        assign('ada', DAY_8, '2026-01-08'),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ overtimeHours: 4, authorisedHours: 0.25 });
    expect(found[0]!.amount).toBe(4);
  });

  it("lets a holdover's own hours take the week past 40", () => {
    // Worked 12 + 12 + 8 + (8 + 3) = 43h; 43 − 40 − 3 = 0, not over.
    const found = unauthorised({
      nurses: [ada()],
      assignments: [
        assign('ada', DAY_12, '2026-01-04'),
        assign('ada', DAY_12, '2026-01-05'),
        assign('ada', DAY_8, '2026-01-07'),
        assign('ada', DAY_8, '2026-01-08', { holdoverMinutes: 180, holdoverMandated: true }),
      ],
    });
    expect(found).toEqual([]);
  });

  it('still lets an authorised-overtime shift cover the whole week', () => {
    // 4 × 12 = 48h: 8h past 40, all covered by Wednesday's authorised overtime, and not past
    // the 48h cap.
    const found = unauthorised({
      nurses: [ada()],
      assignments: [
        assign('ada', DAY_12, '2026-01-04'),
        assign('ada', DAY_12, '2026-01-05'),
        assign('ada', DAY_12, '2026-01-06'),
        assign('ada', DAY_12, '2026-01-07', { isOvertime: true }),
      ],
    });
    expect(found).toEqual([]);
  });

  it("counts a holdover in last period's part of the week toward what it authorises", () => {
    // The schedule opens Wed 7 Jan, inside the week of Sun 4 Jan. Worked 13 + 12 + 12 + 8 = 45h;
    // 45 − 40 − 1 = 4h unauthorised, and only this schedule's two shifts are named.
    const wed = assign('ada', DAY_12, '2026-01-07');
    const thu = assign('ada', DAY_8, '2026-01-08');
    const found = unauthorised({
      startDate: isoDate('2026-01-07'),
      endDate: isoDate('2026-01-20'),
      nurses: [ada()],
      priorAssignments: [
        assign('ada', DAY_12, '2026-01-04', {
          periodId: 'prev',
          holdoverMinutes: 60,
          holdoverMandated: true,
        }),
        assign('ada', DAY_12, '2026-01-05', { periodId: 'prev' }),
      ],
      assignments: [wed, thu],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ overtimeHours: 4, authorisedHours: 1 });
    expect([...found[0]!.assignmentIds].sort()).toEqual([wed.id, thu.id].sort());
  });
});

describe("the overtime a trade's warning quotes", () => {
  // Three D12 Sun–Tue (36h worked) and a 12h standby Wednesday night, in the week of Sun 4 Jan.
  const week = () =>
    scenario({
      nurses: [ada()],
      assignments: [
        assign('ada', DAY_12, '2026-01-04'),
        assign('ada', DAY_12, '2026-01-05'),
        assign('ada', DAY_12, '2026-01-06'),
        assign('ada', ON_CALL, '2026-01-07'),
      ],
    });
  // A 12h paid leave day on Thursday 8 Jan.
  const leave = [{ nurseId: 'ada', date: isoDate('2026-01-08'), hours: 12 }];
  const around = (paidLeaveCountsTowardOvertime: boolean) => {
    const s = week();
    const params = { ...maxHoursRule.defaultParams, paidLeaveCountsTowardOvertime };
    return overtimeHoursAround(s.schedule, 'ada', isoDate('2026-01-06'), params, s.unit, leave);
  };

  it('leaves standby and paid leave out when the contract does not count them', () => {
    // 36h worked; standby and leave not counted: 36 − 40 < 0, so no overtime.
    expect(around(false)).toBe(0);
  });

  it('counts paid leave toward overtime when the contract says it does', () => {
    // 36h worked + 12h leave = 48h; 48 − 40 = 8h. Standby still out.
    expect(around(true)).toBe(8);
  });
});
