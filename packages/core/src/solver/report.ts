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
import type { Id, NurseRole } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { deriveCounters } from '../fairness/ledger.js';
import { scoreFairness } from '../fairness/score.js';
import { evaluateSchedule } from '../rules/registry.js';
import type { Violation } from '../rules/types.js';
import { ScheduleView } from '../schedule/view.js';
import type { SolverModel } from './model.js';
import type { SolveReport, UnfilledSlot } from './types.js';

export function buildReport(model: SolverModel, stats: SolveReport['stats']): SolveReport {
  const { input } = model;
  const assignments = model.assignments();
  const view = new ScheduleView({
    period: input.period,
    assignments,
    priorAssignments: input.priorAssignments,
    nurses: model.nurses,
    shiftTypes: model.shiftTypes,
  });
  const evaluation = evaluateSchedule(view, input.ruleSet, model.ctx);

  const activeNurses = model.candidates.map((i) => model.nurses[i]!);
  const fairness = scoreFairness({
    nurses: activeNurses,
    current: deriveCounters(view, {
      unit: input.unit,
      holidayDates: model.ctx.holidayDates,
      weekendDefinition: input.ruleSet.weekendDefinition,
      preferences: input.preferences,
      timeOff: input.timeOff,
    }),
    history: input.ledgerHistory,
    preferences: input.preferences,
    weights: input.ruleSet.fairnessWeights,
  });

  return {
    assignments,
    unfilled: unfilledFrom(evaluation.hardViolations),
    hardViolations: evaluation.hardViolations,
    softViolations: evaluation.softViolations,
    objective: model.breakdown(),
    fairness,
    ...(model.costCtx ? { cost: costSchedule(view, model.costCtx) } : {}),
    stats,
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
    const d = v.details ?? {};
    const date = v.dates[0];
    if (!date) continue;
    out.push({
      date: date as IsoDate,
      shiftTypeId: String(d.shiftTypeId ?? '') as Id,
      role: d.role as NurseRole,
      required: Number(d.required ?? 0),
      staffed: Number(d.staffed ?? 0),
      shortfall: Number(d.shortfall ?? 0),
      standard: v.code === 'ratio_breach' ? 'ratio' : 'coverage_floor',
    });
  }
  return out;
}
