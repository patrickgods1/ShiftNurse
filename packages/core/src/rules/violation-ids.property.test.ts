/**
 * Invariant: a nurse-scope finding names exactly the in-period shifts that contribute to it, so
 * adding a shift a finding does not name never creates that finding, grows it, or changes what it
 * names. Every amount is a positive, finite number.
 *
 * Why it matters: the solver's identity gate tolerates a hard nurse-scope finding only when every
 * shift it names is locked, and judges "did this move make it worse" by `amount`. A finding that
 * leaves out a contributor would let the solver add to a breach it believes is someone else's,
 * and a finding that names a lookback or other-unit row would point at a shift nobody can move.
 * Hand-written cases cover the shapes we thought of; random rosters with overlaps, holdovers,
 * overtime, leave and a lookback tail cover the ones we did not.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, Nurse, OvertimeVolunteer, ShiftType } from '../domain/entities.js';
import { addDays, type IsoDate, isoDate } from '../domain/time.js';
import { ScheduleView } from '../schedule/view.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  timeOff,
} from '../testing/fixtures.js';
import { ALL_RULES, evaluateSchedule } from './registry.js';
import type { RuleContext, RuleSet, Violation, ViolationCode } from './types.js';
import { AMOUNT_EPSILON, violationKey } from './violation-diff.js';

const SEED = 53;
const TRIALS = 150;
const CANDIDATES_PER_TRIAL = 3;
const MIN_HITS = 5;
const HISTORY_START = isoDate('2025-12-07');
const START = isoDate('2026-01-04');
const END = isoDate('2026-01-31');
const TAIL_DAYS = 28; // Dec 7 – Jan 3
const PERIOD_DAYS = 28; // Jan 4 – Jan 31
const TYPES: readonly ShiftType[] = [DAY_12, NIGHT_12, DAY_8, EVENING_8, NIGHT_8, ON_CALL];

const NURSE_SCOPE_RULE_IDS = ALL_RULES.filter((r) => r.scope === 'nurse').map((r) => r.id);

const MUST_SEE: readonly ViolationCode[] = [
  'insufficient_rest',
  'too_many_consecutive_shifts',
  'missing_required_days_off',
  'overlapping_assignments',
  'over_max_hours',
  'unauthorised_overtime',
  'over_contracted_hours',
  'under_contracted_hours',
  'hours_in_24_exceeded',
  'long_stretch',
  'rest_after_long_stretch',
  'mandatory_overtime',
  'short_tour_change',
  'excess_weekends',
  'works_during_approved_time_off',
  'short_recovery_after_nights',
];

beforeEach(() => resetFixtureCounters());

function team(): Nurse[] {
  return [
    makeNurse({ id: 'pd', employmentType: 'per_diem', contractedHoursPerPeriod: 24 }),
    makeNurse({ id: 'ft1', contractedHoursPerPeriod: 72 }),
    makeNurse({ id: 'ft2', contractedHoursPerPeriod: 72 }),
    // Sixteen years of service at the schedule's start: held to one tour unless she asked.
    makeNurse({ id: 'career', contractedHoursPerPeriod: 72, hireDate: isoDate('2010-03-01') }),
  ];
}

const RULE_PARAMS: Record<string, Record<string, unknown>> = {
  'long-stretch': { maxConsecutiveHours: 16, restAfterHours: 12, restHours: 10 },
  'max-hours-in-24': { maxHours: 16 },
  'no-mandatory-overtime': {
    maxMandatedWeeklyHours: 40,
    maxRequiredConsecutiveHours: 12,
    maxRequiredHoursIn24: 16,
  },
  'tour-rotation': {
    maxToursPerPeriod: 2,
    minHoursBetweenTours: 48,
    exemptAfterYearsOfService: 10,
  },
  'weekend-pattern': { maxConsecutiveWeekends: 2 },
  'days-off-together': {},
};

const VOLUNTEER: OvertimeVolunteer = {
  id: 'ot-ft1',
  unitId: 'unit-1',
  nurseId: 'ft1',
  startDate: isoDate('2026-01-11'),
  endDate: isoDate('2026-01-17'),
  note: 'Any shift that week',
};

/** A random roster over the lookback tail and the period: the same generator for both. */
function randomRoster(rng: Rng, nurses: readonly Nurse[], trial: number) {
  const density = 0.2 + 0.6 * rng.nextFloat();
  const prior: Assignment[] = [];
  const current: Assignment[] = [];
  let n = 0;
  const row = (nurseId: string, date: IsoDate): Assignment => {
    const holdover = rng.chance(0.1);
    return assign(nurseId, rng.pick(TYPES), date, {
      id: `t${trial}-r${n++}`,
      isOvertime: rng.chance(0.1),
      ...(holdover
        ? { holdoverMinutes: rng.nextInt(30, 300), holdoverMandated: rng.chance(0.5) }
        : {}),
    });
  };
  for (const nurse of nurses) {
    for (let day = 0; day < TAIL_DAYS + PERIOD_DAYS; day++) {
      if (!rng.chance(density)) continue;
      const date = addDays(HISTORY_START, day);
      const into = day < TAIL_DAYS ? prior : current;
      into.push(row(nurse.id, date));
      // A second shift the same day, so overlaps and back-to-backs happen.
      if (rng.chance(0.05)) into.push(row(nurse.id, date));
    }
  }
  return { prior, current };
}

/** What Generate adds: a plain, unlocked shift with a fresh id. */
function candidate(rng: Rng, nurses: readonly Nurse[], id: string): Assignment {
  return assign(rng.pick(nurses).id, rng.pick(TYPES), addDays(START, rng.nextInt(0, 27)), {
    id,
    isOvertime: false,
    isLocked: false,
  });
}

function judge(view: ScheduleView, ruleSet: RuleSet, ctx: RuleContext): Violation[] {
  return evaluateSchedule(view, ruleSet, ctx, { only: NURSE_SCOPE_RULE_IDS }).violations;
}

/** Every finding: a positive amount, and only in-period shifts named. */
function wellFormed(findings: readonly Violation[], view: ScheduleView): string[] {
  const problems: string[] = [];
  for (const v of findings) {
    if (!(Number.isFinite(v.amount) && v.amount > 0)) {
      problems.push(`${v.code} has amount ${v.amount}: ${v.message}`);
    }
    for (const id of v.assignmentIds) {
      if (view.get(id)?.inPeriod !== true) {
        problems.push(`${v.code} names ${id}, not an in-period shift: ${v.message}`);
      }
    }
  }
  return problems;
}

const idsOf = (v: Violation) => [...v.assignmentIds].sort().join(',');

describe('which shifts a finding names, over random rosters', () => {
  it('never lets a shift a finding does not name create it, grow it or change what it names', () => {
    const rng = new Rng(SEED);
    const nurses = team();
    const hits = new Map<ViolationCode, number>();
    const problems: string[] = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const { prior, current } = randomRoster(rng, nurses, trial);
      const s = scenario({
        startDate: START,
        endDate: END,
        nurses,
        assignments: current,
        priorAssignments: prior,
        historyFrom: HISTORY_START,
        timeOff: [timeOff('ft2', '2026-01-20', '2026-01-23')],
        overtimeVolunteers: [VOLUNTEER],
        preferences: [
          {
            id: 'pref-career',
            nurseId: 'career',
            kind: 'prefer_shift_type',
            shiftTypeId: NIGHT_12.id,
            weight: 1,
          },
        ],
        ruleParams: RULE_PARAMS,
      });
      const ruleSet: RuleSet = {
        ...s.ruleSet,
        configs: s.ruleSet.configs.map((c) =>
          c.ruleId in RULE_PARAMS ? { ...c, enabled: true } : c,
        ),
      };

      const before = judge(s.schedule, ruleSet, s.ctx);
      problems.push(...wellFormed(before, s.schedule));
      for (const v of before) hits.set(v.code, (hits.get(v.code) ?? 0) + 1);
      const beforeByIdentity = new Map<string, Violation[]>();
      for (const u of before) {
        const key = `${violationKey(u)}#${idsOf(u)}`;
        const group = beforeByIdentity.get(key);
        if (group) group.push(u);
        else beforeByIdentity.set(key, [u]);
      }

      for (let k = 0; k < CANDIDATES_PER_TRIAL; k++) {
        const x = candidate(rng, nurses, `t${trial}-x${k}`);
        const view = new ScheduleView({
          period: s.period,
          assignments: [...current, x],
          priorAssignments: prior,
          nurses,
          shiftTypes: s.shiftTypes,
        });
        const after = judge(view, ruleSet, s.ctx);
        problems.push(...wellFormed(after, view));
        for (const v of after) {
          if (v.assignmentIds.includes(x.id)) continue;
          const matches = beforeByIdentity.get(`${violationKey(v)}#${idsOf(v)}`) ?? [];
          if (!matches.some((u) => u.amount >= v.amount - AMOUNT_EPSILON)) {
            const was = matches.map((u) => u.amount).join(', ') || 'absent';
            problems.push(
              `trial ${trial}: adding ${x.shiftTypeId} on ${x.date} for ${x.nurseId} (${x.id}) ` +
                `changed ${v.ruleId}/${v.code} [${idsOf(v)}] from ${was} to ${v.amount}: ${v.message}`,
            );
          }
        }
      }
    }

    expect(problems.slice(0, 10)).toEqual([]);
    for (const code of MUST_SEE) {
      expect(
        hits.get(code) ?? 0,
        `${code} was seen too rarely to be tested`,
      ).toBeGreaterThanOrEqual(MIN_HITS);
    }
  }, 60_000);
});
