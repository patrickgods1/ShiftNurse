/**
 * Invariant: giving a nurse one more shift in a week never lowers that week's overtime hours or
 * what the nurse costs, under a weekly 40h rule or an 80h pay-period rule. And reordering a week's
 * shifts never changes the overtime premium: weekly overtime hours are max(0, total − 40), and the
 * regular rate they are paid on (29 CFR 778.115) depends only on the week's shifts, not on which
 * one comes last, so the premium is the same up to each line's cent rounding.
 *
 * Why it matters: overtime is priced by walking the nurse's timeline in order, so a shift added
 * early in the week shifts which later shift carries the premium. If the arithmetic ever let an
 * extra shift make a week cheaper, the solver would be rewarded for piling work on one nurse and
 * the budget report would understate exactly the overtime a manager is trying to avoid.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Differential, OvertimeRule } from '../domain/entities.js';
import { addDays, DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  DAY_8,
  DAY_12,
  differential,
  makeNurse,
  NIGHT_12,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  scenario,
  testUnit,
} from '../testing/fixtures.js';
import { costSchedule } from './cost.js';
import type { CostContext } from './types.js';

const SEED = 9001;
const CASES = 200;
const START = isoDate('2026-01-04'); // a Sunday, and the pay period anchor
const SHIFTS = [DAY_12, NIGHT_12, DAY_8];

beforeEach(() => resetFixtureCounters());

function ctxWith(rule: OvertimeRule, differentials: Differential[] = []): CostContext {
  return {
    unit: testUnit,
    payRates: [payRate(48)],
    differentials,
    overtimeRules: [rule],
    holidayDates: new Set(),
    weekendDefinition: DEFAULT_WEEKEND,
    workWeekStartsOn: 0,
  };
}

function nurseCost(rule: OvertimeRule, rows: Assignment[], nurseId: string) {
  const s = scenario({ nurses: [makeNurse({ id: nurseId })], assignments: rows });
  const entry = costSchedule(s.schedule, ctxWith(rule)).nurses.find((n) => n.nurseId === nurseId);
  return { hours: entry?.overtimeHours ?? 0, total: entry?.total ?? 0 };
}

describe('adding a shift to a nurse’s week', () => {
  for (const [name, rule, days] of [
    ['a weekly 40h rule', overtimeRule('weekly', 40), 7],
    ['an 80h pay-period rule', overtimeRule('pay_period', 80), 14],
  ] as const) {
    it(`never lowers overtime hours or cost under ${name}`, () => {
      const rng = new Rng(SEED + days);
      for (let i = 0; i < CASES; i++) {
        const worked: Assignment[] = [];
        const free: number[] = [];
        for (let day = 0; day < days; day++) {
          if (rng.chance(0.6)) {
            worked.push(assign('n', rng.pick(SHIFTS), addDays(START, day), { id: `w${day}` }));
          } else free.push(day);
        }
        if (free.length === 0) continue;
        const extra = assign('n', rng.pick(SHIFTS), addDays(START, rng.pick(free)), {
          id: 'extra',
        });

        const before = nurseCost(rule, worked, 'n');
        const after = nurseCost(rule, [...worked, extra], 'n');
        const msg = `seed ${SEED + days} case ${i} adding ${extra.shiftTypeId} on ${extra.date} to ${worked.map((w) => `${w.date}:${w.shiftTypeId}`).join(',')}`;
        expect(after.hours, msg).toBeGreaterThanOrEqual(before.hours);
        expect(after.total, msg).toBeGreaterThanOrEqual(before.total);
      }
    });
  }
});

describe('reordering a week’s shifts', () => {
  // Weekdays only, so no weekend differential would make the dates themselves matter.
  const WEEKDAYS = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const DIFFERENTIALS = [differential('night', 'flat', 4.5), differential('charge', 'flat', 2.5)];

  function premium(rows: Assignment[]) {
    const s = scenario({ nurses: [makeNurse({ id: 'n' })], assignments: rows });
    const report = costSchedule(s.schedule, ctxWith(overtimeRule('weekly', 40), DIFFERENTIALS));
    const lines = report.assignments.flatMap((a) => a.lines).filter((l) => l.kind === 'overtime');
    return { premium: report.totals.overtimePremium, lines: lines.length };
  }

  it('never changes the nurse’s overtime premium under a weekly 40h rule', () => {
    const rng = new Rng(SEED + 77);
    for (let i = 0; i < CASES; i++) {
      const count = rng.nextInt(3, 5);
      const shifts = Array.from({ length: count }, () => ({
        type: rng.pick(SHIFTS),
        isCharge: rng.chance(0.3),
      }));
      const used = rng.shuffle(WEEKDAYS).slice(0, count).sort();
      const shuffled = rng.shuffle(used);
      const place = (on: string[]) =>
        shifts.map((s, k) => assign('n', s.type, on[k]!, { id: `s${k}`, isCharge: s.isCharge }));
      const a = premium(place(used));
      const b = premium(place(shuffled));
      const msg = `seed ${SEED + 77} case ${i}: ${shifts.map((s) => `${s.type.id}${s.isCharge ? '*' : ''}`).join(',')} on ${used.join(',')} vs ${shuffled.join(',')}`;
      expect(Math.abs(a.premium - b.premium), msg).toBeLessThanOrEqual(0.01 * (a.lines + b.lines));
    }
  });
});
