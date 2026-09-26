/** Generate: the solver's input for a draft, and writing a finished solve back into it. */

import type { Id, SolveInput, SolveReport } from '@shiftnurse/core';
import {
  type DbLike,
  getSolverSettings,
  loadPeriodInput,
  replaceAssignments,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import { cpsatRunnerPath, ORTOOLS_BACKEND_IDS } from '../solver-backends.js';
import { solverAvailability } from '../solver-choice.js';
import { SolverJobs } from '../solver-jobs.js';

import { ACTOR, periodOrThrow } from './context.js';

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
export function applySolveReport(db: ShiftNurseDb, periodId: Id, report: SolveReport) {
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
      },
    );
    const preservedLocked = written.filter((a) => a.isLocked).length;
    return { created: written.length - preservedLocked, preservedLocked };
  });
}

export function createSolverJobs(db: ShiftNurseDb): SolverJobs {
  return new SolverJobs({
    loadInput: (periodId) => buildSolveInput(db, periodId),
    apply: (periodId, report) => applySolveReport(db, periodId, report),
    settings: (periodId) => getSolverSettings(db, periodOrThrow(db, periodId).unitId),
    availability: () => solverAvailability(cpsatRunnerPath() !== undefined, ORTOOLS_BACKEND_IDS),
    runnerPath: cpsatRunnerPath,
  });
}
