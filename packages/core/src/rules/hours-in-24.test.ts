import { beforeEach, describe, expect, it } from 'vitest';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { maxHoursIn24Rule } from './hours-in-24.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = () => makeNurse({ id: 'grace', firstName: 'Grace', lastName: 'Campbell' });

function evaluate(options: ScenarioOptions, maxHours = 16) {
  const s = scenario(options);
  return maxHoursIn24Rule.evaluate(s.schedule, { maxHours }, s.ctx);
}

describe('most hours in any 24', () => {
  it('ships off until a unit sets its limit, hard, at 16 hours', () => {
    expect(maxHoursIn24Rule).toMatchObject({
      id: 'max-hours-in-24',
      severity: 'hard',
      scope: 'nurse',
      category: 'hours',
      enabledByDefault: false,
      defaultParams: { maxHours: 16 },
    });
  });

  it('flags a day 12 held over 5 hours as 17 hours in 24', () => {
    const nurse = grace();
    // 07:00 to 19:00, then held until 00:00 Tue: 17h on the floor.
    const day = assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 300 });
    const found = evaluate({ nurses: [nurse], assignments: [day] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'hours_in_24_exceeded',
      severity: 'hard',
      nurseIds: ['grace'],
      assignmentIds: [day.id],
      details: { hours: 17, maxHours: 16 },
    });
    expect(found[0]!.message).toContain('Grace Campbell');
    expect(found[0]!.message).toContain('17h');
    expect(found[0]!.message).toContain('16h in 24 hours');
  });

  it('accepts a day 12 held over 4 hours: 16 is the limit, not over it', () => {
    const nurse = grace();
    const day = assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 240 });
    expect(evaluate({ nurses: [nurse], assignments: [day] })).toEqual([]);
  });

  it('accepts a day 8 and an evening 8 on the same day: 16 hours', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-05'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('flags the same double once the evening is held over an hour', () => {
    const nurse = grace();
    const day = assign(nurse.id, DAY_8, '2026-01-05');
    const evening = assign(nurse.id, EVENING_8, '2026-01-05', { holdoverMinutes: 60 });
    const found = evaluate({ nurses: [nurse], assignments: [day, evening] });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toEqual({ hours: 17, maxHours: 16 });
    expect([...found[0]!.assignmentIds].sort()).toEqual([day.id, evening.id].sort());
  });

  it('reports a held-over double once, at its worst window', () => {
    const nurse = grace();
    // Day 8 07-15, evening 8 15-23 held 2h to 01:00: the worst 24h is 07:00 to 07:00, 18h.
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_8, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-05', { holdoverMinutes: 120 }),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toEqual({ hours: 18, maxHours: 16 });
  });

  it('accepts a day 12 on Monday and another on Tuesday: never more than 12 in any 24', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05'), assign(nurse.id, DAY_12, '2026-01-06')],
    });
    expect(found).toEqual([]);
  });

  it('forbids a day 12 straight into a night 12, 24 hours with no break', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-05'),
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toEqual({ hours: 24, maxHours: 16 });
  });

  it('does not count on-call standby next to a day shift', () => {
    const nurse = grace();
    const found = evaluate({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, ON_CALL, '2026-01-05'),
      ],
    });
    expect(found).toEqual([]);
  });

  it('does not report a breach that lies entirely in last schedule', () => {
    const nurse = grace();
    const held = assign(nurse.id, DAY_12, '2026-01-02', { periodId: 'prev', holdoverMinutes: 300 });
    expect(evaluate({ nurses: [nurse], priorAssignments: [held] })).toEqual([]);
  });

  it('flags a new shift that completes a breach begun in last schedule', () => {
    const nurse = grace();
    // Night 19:00 Sat 3 Jan to 07:00 Sun, then a day 12 from 07:00 Sun: 24 hours worked.
    const prior = assign(nurse.id, NIGHT_12, '2026-01-03', { periodId: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-04');
    const found = evaluate({ nurses: [nurse], priorAssignments: [prior], assignments: [day] });
    expect(found).toHaveLength(1);
    expect(found[0]!.assignmentIds).toEqual([day.id]);
  });
});
