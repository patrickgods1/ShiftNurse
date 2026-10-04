/**
 * Generate end to end on the scenario unit: real SA + LNS runs (in-process rather than in a
 * worker thread), real candidates, and saving one into the draft through the real repositories.
 */

import { EventEmitter } from 'node:events';
import {
  type Assignment,
  addDays,
  type ComplianceAlert,
  PURE_SOLVERS,
  type Violation,
} from '@shiftnurse/core';
import {
  approveTimeOff,
  auditHistoryFor,
  createTimeOffRequest,
  listAssignmentsForPeriod,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slow } from '../slow.test-support.js';
import { SolverJobs, seedFor } from '../solver-jobs.js';
import type { SolverWorkerData } from '../solver-worker.js';
import { alertsFor } from './alerts.js';
import { ACTOR } from './context.js';
import { costReport } from './cost.js';
import { buildScheduleValidation, scheduleApi } from './schedule.js';
import {
  buildSolveInput,
  compareCandidates,
  previewCandidate,
  saveCandidate,
  scoreDraftObjective,
} from './solver.js';
import { type Fixture, openFixture } from './test-fixture.js';

const ITERATIONS = 3000;

// Each test seeds the scenario unit and solves it up to five times: under 2 s locally, several
// times that on a Windows CI runner.
vi.setConfig({ testTimeout: slow(30_000) });

/** The worker's job, done on the next tick of this thread. */
function inProcessWorker(data: SolverWorkerData) {
  const worker = new EventEmitter();
  setImmediate(() => {
    const report = PURE_SOLVERS[data.solverId]!.solve(data.input, data.options);
    worker.emit('message', { type: 'done', report });
    worker.emit('exit', 0);
  });
  return Object.assign(worker, { terminate: () => undefined });
}

let f: Fixture;
let jobs: SolverJobs;
let periodId: string;

beforeEach(() => {
  f = openFixture();
  periodId = f.seeded.draftPeriodId;
  jobs = new SolverJobs({
    loadInput: (id) => buildSolveInput(f.handle.db, id),
    settings: () => ({ solverId: 'sa-lns', maxIterations: ITERATIONS }),
    availability: () => [{ id: 'sa-lns', available: true }],
    spawnWorker: inProcessWorker,
    scoreDraft: scoreDraftObjective,
    cores: () => 4,
  });
});

afterEach(() => {
  jobs.dispose();
  f.handle.close();
});

async function generate(count: number, continueAfter?: string): Promise<string> {
  const batch = jobs.start(periodId, {
    count,
    ...(continueAfter !== undefined ? { continueAfter } : {}),
  });
  while (jobs.status(batch.id)!.state === 'running') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return batch.id;
}

const cell = (a: Assignment) => `${a.nurseId}|${a.date}|${a.shiftTypeId}|${a.isCharge}`;
const cells = (rows: readonly Assignment[]) => rows.map(cell).sort();
/** Violations by what they say, not by assignment id: a saved row gets a new id. */
const said = (vs: readonly Violation[]) =>
  vs.map((v) => `${v.code}|${[...v.nurseIds].sort()}|${v.dates}`).sort();

describe('generating variations of a draft', () => {
  it('gives the same variations for the same inputs, the first being what one Generate always gave', async () => {
    const a = await generate(2);
    const firstRun = cells(jobs.candidate(a, 0).report.assignments);
    const secondRun = cells(jobs.candidate(a, 1).report.assignments);
    expect(secondRun).not.toEqual(firstRun);

    const alone = PURE_SOLVERS['sa-lns']!.solve(buildSolveInput(f.handle.db, periodId), {
      seed: seedFor(periodId),
      maxIterations: ITERATIONS,
    });
    expect(firstRun).toEqual(cells(alone.assignments));

    const again = await generate(2);
    expect(cells(jobs.candidate(again, 0).report.assignments)).toEqual(firstRun);
    expect(cells(jobs.candidate(again, 1).report.assignments)).toEqual(secondRun);
  });

  it('generates new variations when continuing, the ones a bigger first batch would have held', async () => {
    const all = await generate(5);
    const fiveInOne = [3, 4].map((i) => cells(jobs.candidate(all, i).report.assignments));

    const first = await generate(3);
    const more = await generate(2, first);
    expect(jobs.status(more)!.offset).toBe(3);
    expect([0, 1].map((i) => cells(jobs.candidate(more, i).report.assignments))).toEqual(fiveInOne);
  });

  it('records the continued numbering when a later variation is saved', async () => {
    const first = await generate(2);
    const more = await generate(2, first);
    saveCandidate(f.handle.db, jobs, more, 1);
    const [entry] = auditHistoryFor(f.handle.db, 'schedule_period', periodId).filter(
      (e) => e.action === 'generate',
    );
    expect(entry!.after).toMatchObject({ variation: 4 });
  });

  it('leaves the draft alone until a variation is saved', async () => {
    const before = cells(listAssignmentsForPeriod(f.handle.db, periodId));
    await generate(2);
    expect(cells(listAssignmentsForPeriod(f.handle.db, periodId))).toEqual(before);
  });

  it('saves exactly the chosen variation and records which one it was', async () => {
    const id = await generate(2);
    const chosen = jobs.candidate(id, 1).report;
    saveCandidate(f.handle.db, jobs, id, 1);
    expect(cells(listAssignmentsForPeriod(f.handle.db, periodId))).toEqual(
      cells(chosen.assignments),
    );
    const [entry] = auditHistoryFor(f.handle.db, 'schedule_period', periodId).filter(
      (e) => e.action === 'generate',
    );
    expect(entry!.after).toMatchObject({
      solver: 'sa-lns',
      seed: chosen.stats.seed,
      variation: 2,
    });
    expect(jobs.status(id)!.saved).toBe(1);
  });
});

describe('previewing and comparing', () => {
  it('previews a variation exactly as the grid judges it once saved', async () => {
    const id = await generate(2);
    const preview = previewCandidate(f.handle.db, jobs, id, 1);
    saveCandidate(f.handle.db, jobs, id, 1);
    const onGrid = buildScheduleValidation(f.handle.db, periodId);
    expect(said(preview.validation.result.violations)).toEqual(said(onGrid.result.violations));
    expect(preview.cost.cost.totals).toEqual(costReport(f.handle.db, periodId).cost.totals);
    expect(preview.cost.variance).toEqual(costReport(f.handle.db, periodId).variance);
    // Saving gives the rows database ids; everything else about each alert must match.
    const alertSaid = (alerts: readonly ComplianceAlert[]) =>
      alerts.map(({ assignmentIds, ...rest }) => ({ ...rest, shifts: assignmentIds.length }));
    expect(alertSaid(preview.alerts)).toEqual(alertSaid(alertsFor(f.handle.db, periodId)));
  });

  it('judges a variation’s compliance alerts, not the draft’s', async () => {
    // The draft is empty, so every contracted nurse drifts short of contract; a variation that
    // staffs the period must not be shown those alerts.
    const id = await generate(1);
    const draftAlerts = alertsFor(f.handle.db, periodId);
    expect(draftAlerts.filter((a) => a.kind === 'hours_drift').length).toBeGreaterThan(10);
    const preview = previewCandidate(f.handle.db, jobs, id, 0);
    expect(preview.alerts).not.toEqual(draftAlerts);
    expect(preview.alerts.filter((a) => a.kind === 'hours_drift').length).toBeLessThan(
      draftAlerts.filter((a) => a.kind === 'hours_drift').length,
    );
  });

  it('marks every shift of a variation as new against an empty draft', async () => {
    const id = await generate(1);
    const preview = previewCandidate(f.handle.db, jobs, id, 0);
    expect(listAssignmentsForPeriod(f.handle.db, periodId)).toHaveLength(0);
    expect(preview.diff).toEqual({ added: preview.assignments.length, removed: 0, changed: 0 });
    expect(preview.changedKeys).toHaveLength(preview.assignments.length);
  });

  it('scores the saved draft exactly as it scored the variation it came from', async () => {
    const id = await generate(2);
    saveCandidate(f.handle.db, jobs, id, 0);
    const comparison = compareCandidates(f.handle.db, jobs, id);
    const saved = comparison.candidates.find((c) => c.index === 0)!;
    const { index: _i, seed: _s, solver: _v, elapsedMs: _e, ...savedScore } = saved;
    expect(savedScore.shiftsChanged).toBe(0);
    // The solver sums its objective incrementally, move by move; the draft's is summed afresh.
    // Only the last bits of a float may differ.
    const { objective, preferencePoints, ...rest } = comparison.draft;
    expect(objective).toBeCloseTo(savedScore.objective, 6);
    expect(preferencePoints).toBeCloseTo(savedScore.preferencePoints, 6);
    expect({ ...rest, objective: 0, preferencePoints: 0 }).toEqual({
      ...savedScore,
      objective: 0,
      preferencePoints: 0,
    });
    expect(comparison.candidates.find((c) => c.index === 1)!.shiftsChanged).toBeGreaterThan(0);
  });
});

describe('measuring variations against the schedule already on the grid', () => {
  it('has no grid score while the draft is empty', async () => {
    await generate(1);
    expect(jobs.current(periodId)!.draftObjective).toBeUndefined();
  });

  it('scores the grid as the variation saved onto it', async () => {
    const id = await generate(2);
    saveCandidate(f.handle.db, jobs, id, 1);
    const status = jobs.current(periodId)!;
    expect(status.draftObjective).toBeCloseTo(status.runs[1]!.summary!.objective, 6);
  });
});

describe('when the draft moves under the variations', () => {
  it('refuses to save once a shift has been locked since', async () => {
    const id = await generate(2);
    saveCandidate(f.handle.db, jobs, id, 0);
    const row = listAssignmentsForPeriod(f.handle.db, periodId)[0]!;
    scheduleApi(f.handle.db).setLocked(row.id, true);
    expect(jobs.current(periodId)!.stale).toMatch(/changed since/);
    expect(() => saveCandidate(f.handle.db, jobs, id, 1)).toThrow(/changed since/);
  });

  it('refuses to save once leave has been approved since', async () => {
    const id = await generate(1);
    const request = createTimeOffRequest(
      f.handle.db,
      {
        nurseId: f.rns[0]!.id,
        startDate: addDays(f.seeded.draftStart, 3),
        endDate: addDays(f.seeded.draftStart, 4),
        type: 'pto',
      },
      ACTOR,
    );
    approveTimeOff(f.handle.db, request.id, ACTOR);
    expect(() => saveCandidate(f.handle.db, jobs, id, 0)).toThrow(/changed since/);
  });

  it('still saves after a hand edit to an unlocked shift, which Generate would replace anyway', async () => {
    const id = await generate(2);
    saveCandidate(f.handle.db, jobs, id, 0);
    const row = listAssignmentsForPeriod(f.handle.db, periodId).find((a) => !a.isLocked)!;
    scheduleApi(f.handle.db).deleteAssignment(row.id);
    expect(jobs.current(periodId)!.stale).toBeUndefined();
    const chosen = jobs.candidate(id, 1).report;
    saveCandidate(f.handle.db, jobs, id, 1);
    expect(cells(listAssignmentsForPeriod(f.handle.db, periodId))).toEqual(
      cells(chosen.assignments),
    );
  });
});
