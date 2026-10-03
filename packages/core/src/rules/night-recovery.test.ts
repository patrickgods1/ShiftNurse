import { beforeEach, describe, expect, it } from 'vitest';
import {
  assign,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = () => makeNurse({ firstName: 'Grace', lastName: 'Campbell' });

function recovery(s: ReturnType<typeof scenario>) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'short_recovery_after_nights',
  );
}

describe('days off after nights', () => {
  it('flags a day shift two days after a night: off nights Tuesday morning, back on Wednesday', () => {
    const nurse = grace();
    // Night of Mon Jan 5 runs to 07:00 Tue Jan 6; Day 12 Wed Jan 7 starts 07:00. One day off.
    const night = assign(nurse.id, NIGHT_12, '2026-01-05');
    const day = assign(nurse.id, DAY_12, '2026-01-07');
    const found = recovery(scenario({ nurses: [nurse], assignments: [night, day] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'soft',
      nurseIds: [nurse.id],
      dates: ['2026-01-07'],
      assignmentIds: [day.id, night.id],
    });
    expect(found[0]!.message).toBe(
      'Grace Campbell works the Day 12 on Wed Jan 7 with only 1 day off after nights (Night 12 ' +
        'on Mon Jan 5); 2 are recommended.',
    );
  });

  it('accepts a day shift once two full days have passed: back on Thursday', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-08'),
      ],
    });
    expect(recovery(s)).toEqual([]);
  });

  it('counts an evening shift as a day-side shift too', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, EVENING_8, '2026-01-07'),
      ],
    });
    expect(recovery(s)).toHaveLength(1);
  });

  it('leaves nights followed by nights, and days followed by nights, alone', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, DAY_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-07'),
        assign(nurse.id, NIGHT_12, '2026-01-08'),
      ],
    });
    expect(recovery(s)).toEqual([]);
  });

  it('flags a stretch of nights once, against the last night before the day shift', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, NIGHT_12, '2026-01-06'),
        assign(nurse.id, DAY_12, '2026-01-08'),
      ],
    });
    const found = recovery(s);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('(Night 12 on Tue Jan 6)');
  });

  it('remembers a night worked at the end of the last schedule', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      priorAssignments: [assign(nurse.id, NIGHT_12, '2026-01-03', { periodId: 'period-0' })],
      assignments: [assign(nurse.id, DAY_12, '2026-01-05')],
    });
    expect(recovery(s).map((v) => v.dates)).toEqual([['2026-01-05']]);
  });

  it('can be set to one day off for units that rotate faster', () => {
    const nurse = grace();
    const s = scenario({
      nurses: [nurse],
      assignments: [
        assign(nurse.id, NIGHT_12, '2026-01-05'),
        assign(nurse.id, DAY_12, '2026-01-07'),
      ],
      ruleParams: { 'recovery-after-nights': { daysOffAfterNights: 1 } },
    });
    expect(recovery(s)).toEqual([]);
  });
});
