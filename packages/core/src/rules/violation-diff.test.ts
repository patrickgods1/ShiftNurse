/** What changed between two schedules' findings: a breach that grows is a change too. */

import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { coverageRule } from './coverage-rules.js';
import { maxHoursRule } from './hours-rules.js';
import { violation } from './types.js';
import { diffViolations } from './violation-diff.js';

const overCap = (amount: number) =>
  violation(maxHoursRule, 'hard', 'over_max_hours', 'Ana Ruiz is over the weekly cap.', {
    amount,
    nurseIds: ['ana'],
    dates: [isoDate('2026-01-04'), isoDate('2026-01-10')],
  });

const noCharge = (nurseIds: string[]) =>
  violation(coverageRule, 'hard', 'missing_charge_nurse', 'Mon day has no charge nurse.', {
    amount: 1,
    nurseIds,
    dates: [isoDate('2026-01-05')],
    details: { shiftTypeId: 'day' },
  });

describe("telling one schedule's breaches from another's", () => {
  it('sees a nurse over the weekly cap get further over', () => {
    // 60 h against 48: 12 over; a sixth 12-hour shift makes 72 h: 24 over.
    const diff = diffViolations([overCap(12)], [overCap(24)]);
    expect(diff.worsened).toHaveLength(1);
    expect(diff.worsened[0]!.before.amount).toBe(12);
    expect(diff.worsened[0]!.after.amount).toBe(24);
    expect(diff.introduced).toEqual([]);
    expect(diff.cleared).toEqual([]);
  });

  it('says nothing when the same breach shrinks', () => {
    const diff = diffViolations([overCap(24)], [overCap(12)]);
    expect(diff).toEqual({ introduced: [], worsened: [], cleared: [] });
  });

  it('does not merge two breaches that share a key', () => {
    // After, by amount descending: [3, 2]; before: [2]. 3 pairs with 2 (worse); the 2 is new.
    const diff = diffViolations([overCap(2)], [overCap(2), overCap(3)]);
    expect(diff.worsened).toHaveLength(1);
    expect(diff.worsened[0]!.before.amount).toBe(2);
    expect(diff.worsened[0]!.after.amount).toBe(3);
    expect(diff.introduced.map((v) => v.amount)).toEqual([2]);
    expect(diff.cleared).toEqual([]);
  });

  it('reports a breach that disappears as cleared', () => {
    const diff = diffViolations([overCap(5)], []);
    expect(diff.cleared.map((v) => v.amount)).toEqual([5]);
    expect(diff.introduced).toEqual([]);
    expect(diff.worsened).toEqual([]);
  });

  it("keys a shift's missing charge nurse by the shift, not by who is on it", () => {
    const diff = diffViolations([noCharge(['a'])], [noCharge(['a', 'b'])]);
    expect(diff).toEqual({ introduced: [], worsened: [], cleared: [] });
  });
});
