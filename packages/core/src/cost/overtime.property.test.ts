/**
 * Invariant: giving a nurse one more shift in a week never lowers that week's overtime hours or
 * what the nurse costs, under a weekly 40h rule or an 80h pay-period rule.
 *
 * Why it matters: overtime is priced by walking the nurse's timeline in order, so a shift added
 * early in the week shifts which later shift carries the premium. If the arithmetic ever let an
 * extra shift make a week cheaper, the solver would be rewarded for piling work on one nurse and
 * the budget report would understate exactly the overtime a manager is trying to avoid.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, OvertimeRule } from '../domain/entities.js';
import { addDays, DEFAULT_WEEKEND, isoDate } from '../domain/time.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  DAY_8,
  DAY_12,
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

function ctxWith(rule: OvertimeRule): CostContext {
  return {
    unit: testUnit,
    payRates: [payRate(48)],
    differentials: [],
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
