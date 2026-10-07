import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import type { ScenarioOptions } from '../testing/fixtures.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
  UNIT_ID,
} from '../testing/fixtures.js';
import { type LongStretchParams, longStretchRule } from './long-stretch.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = () => makeNurse({ id: 'grace', firstName: 'Grace', lastName: 'Campbell' });
// Starts at 06:00, an hour before the fixtures' day shift.
const EARLY_12 = {
  ...DAY_12,
  id: 'st-e12',
  name: 'Early 12',
  abbreviation: 'E12',
  startTime: '06:00',
};

function evaluate(options: ScenarioOptions, params: Partial<LongStretchParams>) {
  const s = scenario({ shiftTypes: [...testShiftTypes, EARLY_12], ...options });
  return longStretchRule.evaluate(
    s.schedule,
    { ...longStretchRule.defaultParams, ...params },
    s.ctx,
  );
}

const massachusetts = {
  maxConsecutiveHours: 16,
  emergencyLiftsCap: false,
  restAfterHours: 16,
  restHours: 8,
};

describe('long stretches of work', () => {
  it('ships off, hard, with no number set so a newly enabled rule judges nothing', () => {
    expect(longStretchRule).toMatchObject({
      id: 'long-stretch',
      name: 'Long stretches of work',
      severity: 'hard',
      scope: 'nurse',
      category: 'hours',
      enabledByDefault: false,
    });
    expect(longStretchRule.defaultParams.maxConsecutiveHours).toBeUndefined();
    expect(longStretchRule.defaultParams.restAfterHours).toBeUndefined();
    const nurse = grace();
    const held = assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 600 });
    expect(evaluate({ nurses: [nurse], assignments: [held] }, {})).toEqual([]);
  });

  it('refuses a Massachusetts nurse held 5 hours past a 12-hour shift (17 straight)', () => {
    const nurse = grace();
    const day = assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 300 });
    const found = evaluate({ nurses: [nurse], assignments: [day] }, massachusetts);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'long_stretch',
      severity: 'hard',
      nurseIds: ['grace'],
      assignmentIds: [day.id],
      details: { stretchHours: 17, maxConsecutiveHours: 16 },
    });
    expect(found[0]!.message).toContain('Grace Campbell');
    expect(found[0]!.message).toContain('17h');
  });

  it('allows 16 straight hours exactly under a 16-hour cap', () => {
    const nurse = grace();
    const day = assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 240 });
    expect(evaluate({ nurses: [nurse], assignments: [day] }, massachusetts)).toEqual([]);
  });

  it('counts a day 12 running straight into a night 12 as 24 hours', () => {
    const nurse = grace();
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05'),
          assign(nurse.id, NIGHT_12, '2026-01-05'),
        ],
      },
      { maxConsecutiveHours: 16 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.details).toMatchObject({ stretchHours: 24 });
  });

  it('wants 8 hours off after a 16-hour stretch: back at 07:00 after leaving at 23:30 is too soon', () => {
    const nurse = grace();
    // 07:00 + 12h + 4.5h holdover = 23:30 Monday; Tuesday 07:00 is 7.5h later.
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 270 }),
          assign(nurse.id, DAY_12, '2026-01-06'),
        ],
      },
      { restAfterHours: 16, restHours: 8 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'rest_after_long_stretch',
      nurseIds: ['grace'],
      details: { stretchHours: 16.5, restHours: 8, hoursOff: 7.5 },
    });
    expect(found[0]!.message).toContain('Grace Campbell');
    expect(found[0]!.message).toContain('7.5h');
  });

  it('refuses 7 hours off after 16 hours: out at 23:00, back at 06:00', () => {
    const nurse = grace();
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 240 }),
          assign(nurse.id, EARLY_12, '2026-01-06'),
        ],
      },
      massachusetts,
    );
    expect(found.map((v) => v.code)).toEqual(['rest_after_long_stretch']);
  });

  it('a 12-hour shift ending 19:00 then a holdover-free 07:00 start is 12h of rest and fine', () => {
    const nurse = grace();
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-06'),
        ],
      },
      { restAfterHours: 12, restHours: 10 },
    );
    expect(found).toEqual([]);
  });

  it('with rest only past the threshold, a plain 12-hour shift needs no rest but one held 30 minutes does', () => {
    const nurse = grace();
    // Day 12 ends 19:00 (19:30 held), then a night 8 at 23:00: 4h (3.5h) off against 10h.
    const judge = (holdoverMinutes: number, restOnlyPastThreshold: boolean) =>
      evaluate(
        {
          nurses: [nurse],
          assignments: [
            assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes }),
            assign(nurse.id, NIGHT_8, '2026-01-05'),
          ],
        },
        { restAfterHours: 12, restHours: 10, restOnlyPastThreshold },
      );
    expect(judge(0, true)).toEqual([]);
    expect(judge(30, true).map((v) => v.code)).toEqual(['rest_after_long_stretch']);
    // Without the flag, reaching 12 is enough.
    expect(judge(0, false).map((v) => v.code)).toEqual(['rest_after_long_stretch']);
  });

  it('does not count a volunteered holdover when only required hours count', () => {
    const nurse = grace();
    const judge = (overrides: Parameters<typeof assign>[3]) =>
      evaluate(
        {
          nurses: [nurse],
          assignments: [
            assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 120, ...overrides }),
          ],
        },
        { requiredOnly: true, maxConsecutiveHours: 12 },
      );
    expect(judge({ holdoverMandated: false })).toEqual([]);
    expect(judge({ holdoverMandated: true }).map((v) => v.code)).toEqual(['long_stretch']);
  });

  it('judges every stretch, volunteered or not, when required hours are not the only ones counted', () => {
    const nurse = grace();
    const held = assign(nurse.id, DAY_12, '2026-01-05', {
      holdoverMinutes: 120,
      holdoverMandated: false,
    });
    expect(
      evaluate({ nurses: [nurse], assignments: [held] }, { maxConsecutiveHours: 12 }),
    ).toHaveLength(1);
  });

  it('counts unvolunteered overtime as required, and a volunteer offer on its date as not', () => {
    const nurse = grace();
    const assignments = [
      assign(nurse.id, DAY_12, '2026-01-05'),
      assign(nurse.id, NIGHT_12, '2026-01-05', { isOvertime: true }),
    ];
    const params = { requiredOnly: true, maxConsecutiveHours: 16 };
    expect(evaluate({ nurses: [nurse], assignments }, params).map((v) => v.code)).toEqual([
      'long_stretch',
    ]);
    const offer = {
      id: 'ov-1',
      unitId: UNIT_ID,
      nurseId: nurse.id,
      startDate: isoDate('2026-01-05'),
      endDate: isoDate('2026-01-05'),
    };
    expect(evaluate({ nurses: [nurse], assignments, overtimeVolunteers: [offer] }, params)).toEqual(
      [],
    );
  });

  it('lets a recorded emergency excuse the cap when the unit says so', () => {
    const nurse = grace();
    const held = assign(nurse.id, DAY_12, '2026-01-05', {
      holdoverMinutes: 120,
      holdoverMandated: true,
      notes: 'Emergency: unit surge',
    });
    const params = { requiredOnly: true, maxConsecutiveHours: 12 };
    expect(
      evaluate({ nurses: [nurse], assignments: [held] }, { ...params, emergencyLiftsCap: true }),
    ).toEqual([]);
    expect(
      evaluate({ nurses: [nurse], assignments: [held] }, { ...params, emergencyLiftsCap: false }),
    ).toHaveLength(1);
  });

  it('an emergency note lifts the cap but not the rest after it', () => {
    const nurse = grace();
    // Held to 00:00 Tuesday (17h), back at 07:00: 7h off against 8 required.
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05', {
            holdoverMinutes: 300,
            holdoverMandated: true,
            notes: 'Emergency: no relief available',
          }),
          assign(nurse.id, DAY_12, '2026-01-06'),
        ],
      },
      { ...massachusetts, emergencyLiftsCap: true },
    );
    expect(found.map((v) => v.code)).toEqual(['rest_after_long_stretch']);
  });

  it('a recorded rest waiver excuses the Pennsylvania rest', () => {
    const nurse = grace();
    // Held 4h to 23:00 (16h), back at 07:00 Tuesday: 8h off against 10 required.
    const assignments = [
      assign(nurse.id, DAY_12, '2026-01-05', { holdoverMinutes: 240 }),
      assign(nurse.id, DAY_12, '2026-01-06'),
    ];
    const params = { restAfterHours: 12, restOnlyPastThreshold: true, restHours: 10 };
    expect(evaluate({ nurses: [nurse], assignments }, params)).toHaveLength(1);
    const waiver = (date: string) => ({
      id: `w-${date}`,
      unitId: UNIT_ID,
      nurseId: nurse.id,
      date: isoDate(date),
      reason: 'Signed waiver',
      createdAt: 0,
    });
    const waived = { ...params, honorsRestWaiver: true };
    expect(
      evaluate({ nurses: [nurse], assignments, restWaivers: [waiver('2026-01-06')] }, waived),
    ).toEqual([]);
    // Keyed on the later shift's date, and ignored unless the unit honours waivers.
    expect(
      evaluate({ nurses: [nurse], assignments, restWaivers: [waiver('2026-01-05')] }, waived),
    ).toHaveLength(1);
    expect(
      evaluate({ nurses: [nurse], assignments, restWaivers: [waiver('2026-01-06')] }, params),
    ).toHaveLength(1);
  });

  it('ignores a long stretch wholly in the lookback history', () => {
    const nurse = grace();
    const held = assign(nurse.id, DAY_12, '2026-01-02', { periodId: 'prev', holdoverMinutes: 300 });
    expect(evaluate({ nurses: [nurse], priorAssignments: [held] }, massachusetts)).toEqual([]);
  });

  it('flags a first shift of the schedule that follows a long stretch in history too closely', () => {
    const nurse = grace();
    // Saturday's day 12 held 5h ends 00:00 Sunday; Sunday 07:00 is 7h later.
    const held = assign(nurse.id, DAY_12, '2026-01-03', { periodId: 'prev', holdoverMinutes: 300 });
    const next = assign(nurse.id, DAY_12, '2026-01-04');
    const found = evaluate(
      { nurses: [nurse], priorAssignments: [held], assignments: [next] },
      massachusetts,
    );
    expect(found.map((v) => v.code)).toEqual(['rest_after_long_stretch']);
  });

  it('does not count on-call standby next to a day shift as work', () => {
    const nurse = grace();
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05'),
          assign(nurse.id, ON_CALL, '2026-01-05'),
        ],
      },
      { maxConsecutiveHours: 16, restAfterHours: 12, restHours: 1 },
    );
    expect(found).toEqual([]);
  });

  it('does not let standby join two day shifts into one stretch', () => {
    const nurse = grace();
    // Day 12 Mon, standby overnight, day 12 Tue: two 12h stretches 12h apart, not 36 straight.
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05'),
          assign(nurse.id, ON_CALL, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-06'),
        ],
      },
      { maxConsecutiveHours: 16 },
    );
    expect(found).toEqual([]);
  });

  it('reports one stretch once however many shifts are in it', () => {
    const nurse = grace();
    const found = evaluate(
      {
        nurses: [nurse],
        assignments: [
          assign(nurse.id, DAY_12, '2026-01-05'),
          assign(nurse.id, NIGHT_12, '2026-01-05'),
          assign(nurse.id, DAY_12, '2026-01-06'),
        ],
      },
      { maxConsecutiveHours: 16 },
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.assignmentIds).toHaveLength(3);
  });
});
