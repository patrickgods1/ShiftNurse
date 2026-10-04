/**
 * Invariant: an exchange the preview calls `ok` introduces no hard violation anywhere on the
 * full schedule, and one it calls `blocked` really does introduce one.
 *
 * Why it matters: the exchange evaluator judges only the two nurses and the shifts it touches,
 * for speed. If that shortcut ever missed a breach, a manager would approve a "clean" trade and
 * the grid would turn red afterwards; if it blocked a legal one, nurses would be refused for no
 * reason. The full rule engine over the whole schedule is the independent judge here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { violationKey } from '../conflicts/violation-diff.js';
import type { Assignment, Nurse } from '../domain/entities.js';
import { addDays, isoDate } from '../domain/time.js';
import { evaluateSchedule } from '../rules/registry.js';
import { Rng } from '../solver/rng.js';
import {
  assign,
  coverageAllWeek,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
  solveInputFrom,
} from '../testing/fixtures.js';
import { evaluateExchange, planExchange } from './evaluate.js';
import type { ExchangeProposal } from './types.js';

const SEED = 777;
const CASES = 200;
const START = isoDate('2026-01-04');
const END = isoDate('2026-01-17');
const SHIFTS = [DAY_12, NIGHT_12];

beforeEach(() => resetFixtureCounters());

function randomUnit(rng: Rng): ScenarioOptions {
  const nurses: Nurse[] = [];
  const count = rng.nextInt(3, 5);
  for (let i = 0; i < count; i++) {
    nurses.push(
      makeNurse({
        isChargeEligible: rng.chance(0.5),
        isNovice: rng.chance(0.15),
        ...(rng.chance(0.2)
          ? { employmentType: 'part_time' as const, contractedHoursPerPeriod: 36 }
          : {}),
      }),
    );
  }
  const assignments: Assignment[] = [];
  let n = 0;
  for (const nurse of nurses) {
    for (let day = 0; day < 14; day++) {
      if (!rng.chance(0.45)) continue;
      assignments.push(
        assign(nurse.id, rng.pick(SHIFTS), addDays(START, day), {
          id: `row-${n++}`,
          isCharge: nurse.isChargeEligible && rng.chance(0.3),
        }),
      );
    }
  }
  return {
    startDate: START,
    endDate: END,
    nurses,
    shiftTypes: SHIFTS,
    assignments,
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', rng.nextInt(0, 2)),
      ...coverageAllWeek(NIGHT_12, 'RN', rng.nextInt(0, 2)),
    ],
  };
}

function randomProposal(rng: Rng, opts: ScenarioOptions): ExchangeProposal | undefined {
  const rows = opts.assignments ?? [];
  if (rows.length < 2) return undefined;
  const offered = rng.pick(rows);
  if (rng.chance(0.5)) {
    const others = (opts.nurses ?? []).filter((x) => x.id !== offered.nurseId);
    return {
      kind: 'giveaway',
      requestingNurseId: offered.nurseId,
      counterpartyNurseId: rng.pick(others).id,
      offeredAssignmentId: offered.id,
    };
  }
  const theirs = rows.filter((a) => a.nurseId !== offered.nurseId);
  if (theirs.length === 0) return undefined;
  const requested = rng.pick(theirs);
  return {
    kind: 'trade',
    requestingNurseId: offered.nurseId,
    counterpartyNurseId: requested.nurseId,
    offeredAssignmentId: offered.id,
    requestedAssignmentId: requested.id,
  };
}

function hardKeys(opts: ScenarioOptions, assignments: Assignment[]): Set<string> {
  const s = scenario({ ...opts, assignments });
  const { violations } = evaluateSchedule(s.schedule, s.ruleSet, s.ctx);
  return new Set(violations.filter((v) => v.severity === 'hard').map(violationKey));
}

describe('judging a shift exchange against the whole schedule', () => {
  it('only calls an exchange ok or blocked when the full rule check agrees', () => {
    const rng = new Rng(SEED);
    const seen = { ok: 0, warn: 0, blocked: 0 };
    for (let i = 0; i < CASES; i++) {
      const opts = randomUnit(rng);
      const proposal = randomProposal(rng, opts);
      if (!proposal) continue;
      const input = { ...solveInputFrom(opts), proposal };
      const verdict = evaluateExchange(input).verdict;
      seen[verdict]++;
      if (verdict === 'warn') continue;

      const plan = planExchange(input);
      const removed = new Set(plan.remove);
      const after: Assignment[] = [
        ...(opts.assignments ?? []).filter((a) => !removed.has(a.id)),
        ...plan.create.map((row, k) => ({ id: `new-${k}`, ...row })),
      ];
      const was = hardKeys(opts, opts.assignments ?? []);
      const introduced = [...hardKeys(opts, after)].filter((k) => !was.has(k));

      const msg = `seed ${SEED} case ${i} verdict ${verdict} proposal ${JSON.stringify(proposal)} introduced ${JSON.stringify(introduced)}`;
      if (verdict === 'ok') expect(introduced, msg).toEqual([]);
      else expect(introduced.length, msg).toBeGreaterThan(0);
    }
    // Guard against a generator that only ever produces one kind of verdict.
    expect(seen.ok, `seed ${SEED} ${JSON.stringify(seen)}`).toBeGreaterThan(0);
    expect(seen.blocked, `seed ${SEED} ${JSON.stringify(seen)}`).toBeGreaterThan(0);
  });
});
