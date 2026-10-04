/**
 * Generate: the solver's input for a draft, the candidates a batch produced — previewed and
 * compared by the same engines that judge the grid — and writing the chosen one into the draft.
 */

import { availableParallelism } from 'node:os';
import {
  compareToBudget,
  diffAssignments,
  type Id,
  type ScheduleScore,
  type SolveInput,
  type SolveReport,
  scoreAssignments,
} from '@shiftnurse/core';
import {
  type DbLike,
  getBudget,
  getSolverSettings,
  listAssignmentsForPeriod,
  loadPeriodInput,
  replaceAssignments,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type {
  CandidateComparison,
  CandidatePreview,
  ComparisonColumn,
  ShiftNurseApi,
} from '../../shared/api.js';
import { cpsatRunnerPath, ORTOOLS_BACKEND_IDS } from '../solver-backends.js';
import { solverAvailability } from '../solver-choice.js';
import { SolverJobs, type SolverJobsDeps } from '../solver-jobs.js';

import { alertsForView } from './alerts.js';
import { ACTOR, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';
import { costReportForView } from './cost.js';
import { validateView } from './schedule.js';

/**
 * Everything the solver needs for one draft period, as plain rows — `loadPeriodInput`, the same
 * loader conflicts and costing use — so the schedule the solver emits is judged by exactly the
 * machinery that will judge it on screen.
 */
export function buildSolveInput(db: DbLike, periodId: Id): SolveInput {
  const period = periodOrThrow(db, periodId);
  if (period.status !== 'draft') {
    throw new Error(`Period "${period.name}" is ${period.status}; only a draft can be generated`);
  }
  return loadPeriodInput(db, period);
}

/** Write a finished solve into its period: unlocked rows replaced, locked rows untouched, audited. */
export function applySolveReport(
  db: ShiftNurseDb,
  periodId: Id,
  report: SolveReport,
  details: Record<string, unknown> = {},
) {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    if (period.status !== 'draft') {
      throw new Error(`Period "${period.name}" was ${period.status} before the solve finished`);
    }
    const proposed = report.assignments.filter((a) => !a.isLocked);
    const written = replaceAssignments(
      tx,
      periodId,
      proposed.map((a) => ({
        periodId,
        nurseId: a.nurseId,
        shiftTypeId: a.shiftTypeId,
        date: a.date,
        source: 'solver' as const,
        isCharge: a.isCharge,
        isOvertime: a.isOvertime,
      })),
      ACTOR,
      {
        solver: report.stats.solver,
        seed: report.stats.seed,
        ...(report.stats.fellBackFrom ? { fellBackFrom: report.stats.fellBackFrom } : {}),
        ...details,
      },
    );
    const preservedLocked = written.filter((a) => a.isLocked).length;
    return { created: written.length - preservedLocked, preservedLocked };
  });
}

function candidateKey(a: { nurseId: Id; date: string; shiftTypeId: Id }): string {
  return `${a.nurseId}|${a.date}|${a.shiftTypeId}`;
}

/**
 * A candidate on the grid: its rows, and everything the schedule page reads off them — the
 * validation, the cost strip against the budget and the compliance alerts — judged on the
 * candidate, so a preview shows what saving it would.
 */
export function previewCandidate(
  db: DbLike,
  jobs: SolverJobs,
  batchId: Id,
  index: number,
): CandidatePreview {
  const { batch, report } = jobs.candidate(batchId, index);
  const period = periodOrThrow(db, batch.periodId);
  const view = scheduleViewFor(db, period, { lookback: true, assignments: report.assignments });
  const draft = listAssignmentsForPeriod(db, period.id);
  const diff = diffAssignments(draft, report.assignments);
  const ruleSet = ruleSetFor(db, period);
  return {
    batchId,
    index,
    assignments: report.assignments,
    validation: validateView(db, period, ruleSet, view),
    cost: costReportForView(db, period, view),
    alerts: alertsForView(db, period, ruleSet, view),
    changedKeys: diff.changes.filter((c) => c.kind !== 'removed').map((c) => candidateKey(c)),
    diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
  };
}

function column(
  score: ScheduleScore,
  budgetDollars: number | undefined,
  shiftsChanged: number,
  contracted: ReadonlySet<Id>,
): ComparisonColumn {
  // Per-diem staff have no fair share to fall short of: the least fairly treated nurse is one
  // with contracted hours, or the column names a per-diem nurse who simply picked up little.
  const scores = score.fairness.scores.filter((s) => contracted.has(s.nurseId));
  const worst = scores.reduce<(typeof scores)[number] | undefined>(
    (low, s) => (low === undefined || s.score < low.score ? s : low),
    undefined,
  );
  return {
    floorsShort: score.unfilled.reduce((sum, slot) => sum + slot.shortfall, 0),
    hardViolations: score.hardViolations.length,
    softViolations: score.softViolations.length,
    fairnessMean:
      scores.length > 0 ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length : 0,
    fairnessGini: score.fairness.distribution.score.gini,
    ...(worst ? { worstNurse: { nurseId: worst.nurseId, score: worst.score } } : {}),
    preferencePoints: score.objective.preferences,
    objective: score.objective.total,
    ...(score.cost
      ? {
          overtimeHours: score.cost.totals.overtimeHours,
          costTotal: score.cost.totals.total,
          unpricedAssignments: score.cost.unpricedAssignments,
          ...(budgetDollars !== undefined
            ? { budgetVariance: compareToBudget(score.cost.totals.total, budgetDollars) }
            : {}),
        }
      : {}),
    shiftsChanged,
    digest: score.digest,
  };
}

/**
 * The current draft beside every finished variation. Every column — the draft included — is
 * scored by `scoreAssignments`/`buildReport`, the one objective and rule engine, so a
 * difference between two columns is a difference between the schedules, never between judges.
 */
export function compareCandidates(db: DbLike, jobs: SolverJobs, batchId: Id): CandidateComparison {
  const candidates = jobs.candidates(batchId);
  const status = jobs.status(batchId);
  if (!status) throw new Error('These variations are gone; generate again');
  const input = buildSolveInput(db, status.periodId);
  const draft = input.assignments;
  const budget = getBudget(db, status.periodId)?.targetDollars;
  const contracted = new Set(
    input.nurses.filter((n) => n.contractedHoursPerPeriod > 0).map((n) => n.id),
  );
  const size = (a: SolveReport['assignments']) => {
    const d = diffAssignments(draft, a);
    return d.added + d.removed + d.changed;
  };
  return {
    batchId,
    draft: column(scoreAssignments(input, draft), budget, 0, contracted),
    candidates: candidates.map(({ index, report }) => {
      return {
        ...column(report, budget, size(report.assignments), contracted),
        index,
        seed: report.stats.seed,
        solver: report.stats.solver,
        ...(report.stats.fellBackFrom ? { fellBackFrom: report.stats.fellBackFrom } : {}),
        elapsedMs: report.stats.elapsedMs,
      };
    }),
  };
}

/** Write one variation into the draft, after checking it is still a fair answer to today's inputs. */
export function saveCandidate(db: ShiftNurseDb, jobs: SolverJobs, batchId: Id, index: number) {
  const { batch, report } = jobs.candidate(batchId, index);
  const applied = applySolveReport(db, batch.periodId, report, {
    variation: batch.offset + index + 1,
  });
  jobs.markSaved(batchId, index);
  return applied;
}

/** The grid's schedule, scored the way every variation is; undefined while the grid is empty. */
export function scoreDraftObjective(input: SolveInput): number | undefined {
  return input.assignments.length > 0
    ? scoreAssignments(input, input.assignments).objective.total
    : undefined;
}

export function createSolverJobs(
  db: ShiftNurseDb,
  spawnWorker: SolverJobsDeps['spawnWorker'],
): SolverJobs {
  return new SolverJobs({
    loadInput: (periodId) => buildSolveInput(db, periodId),
    settings: (periodId) => getSolverSettings(db, periodOrThrow(db, periodId).unitId),
    availability: () => solverAvailability(cpsatRunnerPath() !== undefined, ORTOOLS_BACKEND_IDS),
    runnerPath: cpsatRunnerPath,
    spawnWorker,
    scoreDraft: scoreDraftObjective,
    cores: availableParallelism,
    changeCount: () => (db.$client.prepare('select total_changes() as n').get() as { n: number }).n,
  });
}

export function solverApi(db: ShiftNurseDb, jobs: SolverJobs): ShiftNurseApi['solver'] {
  return {
    start: (periodId, options) => jobs.start(periodId, options),
    status: (batchId) => jobs.status(batchId),
    cancel: (batchId) => jobs.cancel(batchId),
    current: (periodId) => jobs.current(periodId),
    discard: (batchId) => jobs.discard(batchId),
    estimate: (periodId, options) => jobs.estimate(periodId, options),
    candidate: (batchId, index) => previewCandidate(db, jobs, batchId, index),
    compare: (batchId) => compareCandidates(db, jobs, batchId),
    save: (batchId, index) => saveCandidate(db, jobs, batchId, index),
    available: () => solverAvailability(cpsatRunnerPath() !== undefined, ORTOOLS_BACKEND_IDS),
  };
}
