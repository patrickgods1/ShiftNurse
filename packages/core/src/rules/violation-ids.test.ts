import { beforeEach, describe, expect, it } from 'vitest';
import {
  assign,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
} from '../testing/fixtures.js';
import { overlapRule } from './availability-rules.js';
import { longStretchRule } from './long-stretch.js';
import { evaluateSchedule } from './registry.js';
import { tourRotationRule } from './tour-rotation.js';

beforeEach(() => {
  resetFixtureCounters();
});

const grace = () => makeNurse({ id: 'grace', firstName: 'Grace', lastName: 'Campbell' });

function found(s: ReturnType<typeof scenario>, code: string) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter((v) => v.code === code);
}

describe('which shifts a finding names', () => {
  it("names only this period's shift when last period's night is too close", () => {
    const nurse = grace();
    const prev = assign(nurse.id, NIGHT_12, '2026-01-03', { id: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-04', { id: 'day' });
    const s = scenario({ nurses: [nurse], priorAssignments: [prev], assignments: [day] });
    const rest = found(s, 'insufficient_rest');
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      assignmentIds: ['day'],
      dates: ['2026-01-04'],
      amount: 10,
    });
  });

  it('names both stretches when days off after a full run are too few', () => {
    const nurse = grace();
    const run = [5, 6, 7, 8, 9].map((d) =>
      assign(nurse.id, DAY_12, `2026-01-0${d}`, { id: `d${d}` }),
    );
    const after = assign(nurse.id, DAY_12, '2026-01-11', { id: 'd11' });
    const s = scenario({ nurses: [nurse], assignments: [...run, after] });
    const missing = found(s, 'missing_required_days_off');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      assignmentIds: ['d5', 'd6', 'd7', 'd8', 'd9', 'd11'],
      amount: 1,
    });
  });

  it("leaves last period's shift off a long stretch's names", () => {
    const nurse = grace();
    const prev = assign(nurse.id, EVENING_8, '2026-01-03', {
      id: 'prev',
      holdoverMinutes: 480,
      holdoverMandated: true,
    });
    const day = assign(nurse.id, DAY_12, '2026-01-04', { id: 'day' });
    const s = scenario({ nurses: [nurse], priorAssignments: [prev], assignments: [day] });
    const out = longStretchRule
      .evaluate(s.schedule, { ...longStretchRule.defaultParams, maxConsecutiveHours: 16 }, s.ctx)
      .filter((v) => v.code === 'long_stretch');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ assignmentIds: ['day'], dates: ['2026-01-04'], amount: 12 });
  });

  it("names a recovery breach's night only when it is this period's", () => {
    const nurse = grace();
    const prev = assign(nurse.id, NIGHT_12, '2026-01-03', { id: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-04', { id: 'day' });
    const s = scenario({ nurses: [nurse], priorAssignments: [prev], assignments: [day] });
    const rec = found(s, 'short_recovery_after_nights');
    expect(rec).toHaveLength(1);
    expect(rec[0]!.assignmentIds).toEqual(['day']);
  });

  it("names only this period's shift when it overlaps last period's night", () => {
    const nurse = grace();
    const early = {
      ...DAY_12,
      id: 'st-e12',
      name: 'Early 12',
      abbreviation: 'E12',
      startTime: '06:00',
    };
    // Night of Jan 3 runs to 07:00 Jan 4; the 06:00 start overlaps its last hour.
    const prev = assign(nurse.id, NIGHT_12, '2026-01-03', { id: 'prev' });
    const day = assign(nurse.id, early, '2026-01-04', { id: 'day' });
    const s = scenario({
      nurses: [nurse],
      shiftTypes: [...testShiftTypes, early],
      priorAssignments: [prev],
      assignments: [day],
    });
    const out = overlapRule.evaluate(s.schedule, overlapRule.defaultParams, s.ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ assignmentIds: ['day'], dates: ['2026-01-04'], amount: 1 });
  });

  it("names only this period's shift when a tour change follows last period's night", () => {
    const nurse = grace();
    const prev = assign(nurse.id, NIGHT_12, '2026-01-03', { id: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-04', { id: 'day' });
    const s = scenario({ nurses: [nurse], priorAssignments: [prev], assignments: [day] });
    const out = tourRotationRule
      .evaluate(s.schedule, tourRotationRule.defaultParams, s.ctx)
      .filter((v) => v.code === 'short_tour_change');
    expect(out).toHaveLength(1);
    // 0 h off against 48 required.
    expect(out[0]).toMatchObject({ assignmentIds: ['day'], dates: ['2026-01-04'], amount: 48 });
  });

  it("leaves last period's evening off the names when the next shift comes too soon", () => {
    const nurse = grace();
    // 15:00-23:00 Jan 3 is 8 h; 07:00 Jan 4 is 8 h later, 10 required.
    const prev = assign(nurse.id, EVENING_8, '2026-01-03', { id: 'prev' });
    const day = assign(nurse.id, DAY_12, '2026-01-04', { id: 'day' });
    const s = scenario({ nurses: [nurse], priorAssignments: [prev], assignments: [day] });
    const out = longStretchRule
      .evaluate(s.schedule, { ...longStretchRule.defaultParams, restAfterHours: 8 }, s.ctx)
      .filter((v) => v.code === 'rest_after_long_stretch');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ assignmentIds: ['day'], dates: ['2026-01-04'], amount: 2 });
  });
});
