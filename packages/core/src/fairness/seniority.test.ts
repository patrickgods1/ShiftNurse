import { describe, expect, it } from 'vitest';
import type { Preference } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { preferenceWeight, seniorityMultiplier, seniorityMultipliers } from './seniority.js';

describe('seniority multipliers', () => {
  it('gives the most senior nurse 1.5x, the least senior 1x, and the middle nurse 1.25x on the default 0.5 boost', () => {
    resetFixtureCounters();
    const senior = makeNurse({ seniorityDate: isoDate('2010-01-01') }); // hired first
    const middle = makeNurse({ seniorityDate: isoDate('2015-01-01') });
    const junior = makeNurse({ seniorityDate: isoDate('2020-01-01') }); // hired last
    const multipliers = seniorityMultipliers([senior, middle, junior]);
    expect(multipliers.get(senior.id)).toBeCloseTo(1.5, 6);
    expect(multipliers.get(middle.id)).toBeCloseTo(1.25, 6);
    expect(multipliers.get(junior.id)).toBeCloseTo(1.0, 6);
  });

  it('gives nurses hired on the same date the same multiplier — hire date ties, not clock-in order', () => {
    resetFixtureCounters();
    const a = makeNurse({ seniorityDate: isoDate('2018-06-01') });
    const b = makeNurse({ seniorityDate: isoDate('2018-06-01') });
    const junior = makeNurse({ seniorityDate: isoDate('2022-01-01') });
    const multipliers = seniorityMultipliers([a, b, junior]);
    expect(multipliers.get(a.id)).toBe(multipliers.get(b.id));
    expect(multipliers.get(a.id)).toBeCloseTo(1.5, 6);
  });

  it('a lone nurse on the roster has no one to be senior over, so their multiplier is 1', () => {
    resetFixtureCounters();
    const solo = makeNurse({ seniorityDate: isoDate('2012-01-01') });
    expect(seniorityMultiplier(solo, [solo])).toBe(1);
  });

  it('a zero boost turns seniority weighting off entirely, even with a wide spread of hire dates', () => {
    resetFixtureCounters();
    const senior = makeNurse({ seniorityDate: isoDate('2005-01-01') });
    const junior = makeNurse({ seniorityDate: isoDate('2024-01-01') });
    const multipliers = seniorityMultipliers([senior, junior], { boost: 0 });
    expect(multipliers.get(senior.id)).toBe(1);
    expect(multipliers.get(junior.id)).toBe(1);
  });

  it("weights a senior nurse's unmet preference above a junior nurse's identical one", () => {
    resetFixtureCounters();
    const senior = makeNurse({ seniorityDate: isoDate('2010-01-01') });
    const junior = makeNurse({ seniorityDate: isoDate('2020-01-01') });
    const nurses = [senior, junior];
    const pref = (nurseId: string): Preference => ({
      id: 'pref-1',
      nurseId,
      kind: 'avoid_weekday',
      weekday: 6,
      weight: 4,
    });
    const seniorWeight = preferenceWeight(pref(senior.id), senior, nurses);
    const juniorWeight = preferenceWeight(pref(junior.id), junior, nurses);
    // Same stated weight (4), but the senior nurse's boost (1.5x) beats the junior's (1x).
    expect(seniorWeight).toBeCloseTo(6, 6);
    expect(juniorWeight).toBeCloseTo(4, 6);
  });
});
