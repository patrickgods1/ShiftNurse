/**
 * The one place a solve becomes a `SolveReport`, shared by every backend.
 *
 * The report is produced by the same `evaluateSchedule` / `scoreFairness` / `costSchedule` the
 * grid, the Fairness screen and the Cost strip use — never by a backend's own internal tallies.
 * If the two ever disagreed, the manager would see a Generate summary that the schedule page
 * then contradicted; deriving both from one engine makes that impossible. It is also what makes
 * backends comparable point-for-point: whatever produced the assignments, the objective is read
 * off the same `SolverModel`.
 */

import { costSchedule } from '../cost/cost.js';
import type { Assignment, Id, NurseRole } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import { evaluateSchedule } from '../rules/registry.js';
import { detailNumber, detailString, type Violation } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import { digestSchedule } from './digest.js';
import { SolverModel } from './model.js';
import type { SolveInput, SolveReport, UnfilledSlot } from './types.js';

/** Everything a report says about a schedule, without who solved it or how. */
export type ScheduleScore = Omit<SolveReport, 'assignments' | 'stats'>;

export function buildReport(model: SolverModel, stats: SolveReport['stats']): SolveReport {
  const assignments = model.assignments();
  return { assignments, ...scoreModel(model, assignments), stats };
}

/**
 * Score a schedule that no solver produced — the draft on the grid, hand edits and all — by the
 * objective and engine a solve report uses, so Generate's candidates can be compared with it
 * point for point. Every row is pinned: the model's constructor keeps locked rows and discards
 * the rest, and here nothing is to be discarded, moved or given the charge.
 */
export function scoreAssignments(
  input: SolveInput,
  assignments: readonly Assignment[],
): ScheduleScore {
  const pinned = assignments.map((a) => (a.isLocked ? a : { ...a, isLocked: true }));
  const model = new SolverModel({ ...input, assignments: pinned });
  return scoreModel(model, [...assignments]);
}

function scoreModel(model: SolverModel, assignments: Assignment[]): ScheduleScore {
  const { input } = model;
  const view = new ScheduleView({
    period: input.period,
    assignments,
    priorAssignments: input.priorAssignments,
    nurses: model.nurses,
    shiftTypes: model.shiftTypes,
  });
  const evaluation = evaluateSchedule(view, input.ruleSet, model.ctx);

  const activeNurses = model.candidates.map((i) => model.nurses[i]!);
  const counters = deriveCounters(view, {
    unit: input.unit,
    holidayDates: model.ctx.holidayDates,
    weekendDefinition: input.ruleSet.weekendDefinition,
    preferences: input.preferences,
    timeOff: input.timeOff,
  });
  const fairness = scoreFairness({
    nurses: activeNurses,
    current: counters,
    history: input.ledgerHistory,
    preferences: input.preferences,
    weights: input.ruleSet.fairnessWeights,
  });

  return {
    unfilled: unfilledFrom(evaluation.hardViolations),
    hardViolations: evaluation.hardViolations,
    softViolations: evaluation.softViolations,
    objective: model.breakdown(),
    fairness,
    digest: digestSchedule({
      nurses: activeNurses,
      counters,
      violations: [...evaluation.hardViolations, ...evaluation.softViolations],
    }),
    ...(model.costCtx ? { cost: costSchedule(view, model.costCtx) } : {}),
  };
}

/**
 * Staffing gaps, read off the coverage and ratio violations rather than counted separately,
 * so the Generate summary and the grid's red badges can never disagree about what is short.
 */
function unfilledFrom(violations: readonly Violation[]): UnfilledSlot[] {
  const out: UnfilledSlot[] = [];
  for (const v of violations) {
    if (v.code !== 'understaffed' && v.code !== 'ratio_breach') continue;
    const date = v.dates[0];
    if (!date) continue;
    out.push({
      date: date as IsoDate,
      shiftTypeId: detailString(v, 'shiftTypeId') as Id,
      role: detailString(v, 'role') as NurseRole,
      required: detailNumber(v, 'required'),
      staffed: detailNumber(v, 'staffed'),
      shortfall: detailNumber(v, 'shortfall'),
      standard: v.code === 'ratio_breach' ? 'ratio' : 'coverage_floor',
    });
  }
  return out;
}
