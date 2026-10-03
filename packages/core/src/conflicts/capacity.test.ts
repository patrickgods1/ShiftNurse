import { beforeEach, describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import {
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { leaveCapacity } from './capacity.js';

beforeEach(() => {
  resetFixtureCounters();
});

/**
 * Four RNs on 84 hours a fortnight — 84 / 14 / 12 = half a 12-hour shift a day each, two a day
 * between them — against one RN on days and one on nights: needed 2, supplied 2.
 */
function unit(extra: { perDiem?: number } = {}) {
  const rns = Array.from({ length: 4 }, (_, i) =>
    makeNurse({ id: `rn${i}`, contractedHoursPerPeriod: 84 }),
  );
  const perDiem = Array.from({ length: extra.perDiem ?? 0 }, (_, i) =>
    makeNurse({
      id: `pd${i}`,
      employmentType: 'per_diem',
      contractedHoursPerPeriod: 0,
      fte: 0,
    }),
  );
  return { rns, perDiem, nurses: [...rns, ...perDiem] };
}

const base = (
  nurses: ReturnType<typeof unit>['nurses'],
  timeOffs: Parameters<typeof timeOff>[] = [],
) =>
  solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 1),
      ...coverageAllWeek(NIGHT_12, 'RN', 1),
    ],
    timeOff: timeOffs.map((args) => timeOff(...args)),
  });

describe('whether the unit can spare a nurse on the days asked for', () => {
  it('reads a day as covered when the rest of the staff still supply what the floors need', () => {
    // Five RNs at half a shift a day: 2.5 supplied, 2 needed; four left after the request.
    const rns = [...unit().rns, makeNurse({ id: 'rn4', contractedHoursPerPeriod: 84 })];
    const input = base(rns, [
      ['rn0', '2026-01-05', '2026-01-05', { id: 'ask', status: 'pending' }],
    ]);
    expect(leaveCapacity(input, 'ask')).toEqual([
      {
        date: '2026-01-05',
        role: 'RN',
        needed: 2,
        supply: 2,
        usualSupply: 2.5,
        perDiem: 0,
        offApproved: 0,
        offPending: 0,
        verdict: 'ok',
        verdictIfAllApproved: 'ok',
      },
    ]);
  });

  it('calls it tight when leave takes a whole shift a day more than usual from per-diem', () => {
    // rn1 already approved off and rn0 asking: two RNs left supply 1.0 against 2 needed, where
    // all four would supply 2.0 — a whole shift more than usual, which the per-diem RN can take.
    const { nurses } = unit({ perDiem: 1 });
    const input = base(nurses, [
      ['rn1', '2026-01-05', '2026-01-05', { id: 'off', status: 'approved' }],
      ['rn0', '2026-01-05', '2026-01-05', { id: 'ask', status: 'pending' }],
    ]);
    const [day] = leaveCapacity(input, 'ask');
    expect(day).toMatchObject({ supply: 1, usualSupply: 2, perDiem: 1, verdict: 'tight' });
  });

  it('does not flag a unit that always fills a small gap with per-diem staff', () => {
    // Four RNs on 72 hours a fortnight supply 72 / 14 / 12 = 0.43 of a shift a day each: 1.7
    // between them against 2 needed, so two per-diem RNs make up 0.3 a day on any ordinary day.
    // One nurse off leaves 1.3 — 0.43 more than usual, absorbed within the pay period, not a
    // day the manager needs warning about.
    const rns = Array.from({ length: 4 }, (_, i) =>
      makeNurse({ id: `rn${i}`, contractedHoursPerPeriod: 72 }),
    );
    const { perDiem } = unit({ perDiem: 2 });
    const input = base(
      [...rns, ...perDiem],
      [['rn0', '2026-01-05', '2026-01-05', { id: 'ask', status: 'pending' }]],
    );
    const [day] = leaveCapacity(input, 'ask');
    expect(day).toMatchObject({ supply: 1.3, usualSupply: 1.7, verdict: 'ok' });
  });

  it('calls it short when nobody is left to cover, counting who is already approved off', () => {
    // rn1 is already off: two RNs left supply 1.0, with no per diem, against 2 needed.
    const { nurses } = unit();
    const input = base(nurses, [
      ['rn1', '2026-01-05', '2026-01-05', { id: 'off', status: 'approved' }],
      ['rn0', '2026-01-05', '2026-01-05', { id: 'ask', status: 'pending' }],
    ]);
    const [day] = leaveCapacity(input, 'ask');
    expect(day).toMatchObject({ supply: 1, offApproved: 1, verdict: 'short' });
  });

  it('warns when this request is fine alone but not if the others that day are approved too', () => {
    // With rn0 off: 1.5 supplied against a usual 2.0, half a shift more than usual. If rn2's
    // and rn3's pending requests are approved too, 0.5 is left and the one per diem cannot
    // make up the other 1.5.
    const { nurses } = unit({ perDiem: 1 });
    const input = base(nurses, [
      ['rn0', '2026-01-05', '2026-01-05', { id: 'ask', status: 'pending' }],
      ['rn2', '2026-01-05', '2026-01-05', { id: 'p2', status: 'pending' }],
      ['rn3', '2026-01-05', '2026-01-06', { id: 'p3', status: 'pending' }],
    ]);
    const [day] = leaveCapacity(input, 'ask');
    expect(day).toMatchObject({ offPending: 2, verdict: 'ok', verdictIfAllApproved: 'short' });
  });

  it('only looks at the days of the request that fall in the period', () => {
    const { nurses } = unit();
    const input = base(nurses, [
      ['rn0', '2026-01-16', '2026-01-20', { id: 'ask', status: 'pending' }],
    ]);
    expect(leaveCapacity(input, 'ask').map((d) => d.date)).toEqual(['2026-01-16', '2026-01-17']);
  });
});
