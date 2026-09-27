import { EventEmitter } from 'node:events';
import type { SolveInput, SolveReport } from '@shiftnurse/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SolverWorkerHandle } from './solver-jobs.js';
import { SolverJobs } from './solver-jobs.js';
import type { SolverWorkerData, SolverWorkerMessage } from './solver-worker.js';

/** A worker the test finishes by hand, so the queue can be observed between runs. */
class FakeWorker extends EventEmitter implements SolverWorkerHandle {
  terminated = false;
  constructor(readonly data: SolverWorkerData) {
    super();
  }
  terminate() {
    this.terminated = true;
  }
  finish(objective: number, cancelled = false) {
    const message: SolverWorkerMessage = {
      type: 'done',
      report: {
        assignments: [],
        unfilled: [],
        hardViolations: [],
        softViolations: [],
        objective: {
          total: objective,
          coverage: 0,
          hours: 0,
          fairness: 0,
          preferences: 0,
          cost: 0,
        },
        fairness: {} as SolveReport['fairness'],
        stats: {
          solver: this.data.solverId,
          seed: this.data.options.seed,
          iterations: 1,
          accepted: 1,
          improvements: 1,
          elapsedMs: 1000 + objective,
          cancelled,
          timedOut: false,
          seedObjective: objective,
        },
      },
    };
    this.emit('message', message);
    this.emit('exit', 0);
  }
}

let workers: FakeWorker[];
let inputVersion: number;

function input(): SolveInput {
  return {
    unit: { id: 'unit-1' },
    period: { id: 'period-1', startDate: '2026-01-04', endDate: '2026-01-17' },
    nurses: [],
    assignments: [],
    timeOff: inputVersion > 0 ? [{ id: `leave-${inputVersion}` }] : [],
  } as unknown as SolveInput;
}

function jobs(cores = 3) {
  return new SolverJobs({
    loadInput: () => input(),
    settings: () => ({ solverId: 'sa-lns' }),
    availability: () => [{ id: 'sa-lns', available: true }],
    spawnWorker: (data) => {
      const worker = new FakeWorker(data);
      workers.push(worker);
      return worker;
    },
    cores: () => cores,
    now: () => 0,
  });
}

beforeEach(() => {
  workers = [];
  inputVersion = 0;
});

describe('a batch of variations', () => {
  it('never runs more at once than the machine has room for, and starts the next as one ends', () => {
    // Three cores: two annealing runs at a time.
    const j = jobs(3);
    const batch = j.start('period-1', { count: 5, seed: 100 });
    expect(batch.concurrency).toBe(2);
    expect(workers).toHaveLength(2);
    workers[0]!.finish(50);
    expect(workers).toHaveLength(3);
    expect(j.status(batch.id)!.runs.map((r) => r.state)).toEqual([
      'done',
      'running',
      'running',
      'queued',
      'queued',
    ]);
  });

  it('seeds variation k with the base seed plus k', () => {
    const j = jobs(8);
    j.start('period-1', { count: 3, seed: 100 });
    expect(workers.map((w) => w.data.options.seed)).toEqual([100, 101, 102]);
  });

  it('writes nothing on its own and names the lowest-scoring variation best', () => {
    const j = jobs(8);
    const batch = j.start('period-1', { count: 3 });
    workers[0]!.finish(300);
    workers[1]!.finish(100);
    workers[2]!.finish(200);
    const done = j.status(batch.id)!;
    expect(done.state).toBe('done');
    expect(done.best).toBe(1);
    expect(done.saved).toBeUndefined();
    expect(j.candidates(batch.id).map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('keeps finished variations when the manager stops the rest', () => {
    const j = jobs(3);
    const batch = j.start('period-1', { count: 4 });
    workers[0]!.finish(10);
    j.cancel(batch.id);
    // Runs 2 and 3 were going (two slots); each reports back cancelled, as a real worker does
    // once it sees the flag. Run 4 never started.
    expect(workers).toHaveLength(3);
    workers[1]!.finish(20, true);
    workers[2]!.finish(30, true);
    const status = j.status(batch.id)!;
    expect(status.state).toBe('done');
    expect(status.cancelled).toBe(true);
    expect(status.runs.map((r) => r.state)).toEqual([
      'done',
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(j.candidates(batch.id).map((c) => c.index)).toEqual([0]);
  });

  it('carries seeds and numbering on when generating again, and starts over when not', () => {
    const j = jobs(8);
    const first = j.start('period-1', { count: 3, seed: 100 });
    for (const w of workers) w.finish(10);
    const second = j.start('period-1', { count: 2, seed: 100, continueAfter: first.id });
    expect(second.offset).toBe(3);
    expect(second.runs.map((r) => r.seed)).toEqual([103, 104]);
    for (const w of workers.slice(3)) w.finish(10);
    const third = j.start('period-1', { count: 2, seed: 100, continueAfter: second.id });
    expect(third.offset).toBe(5);
    expect(third.runs.map((r) => r.seed)).toEqual([105, 106]);
    for (const w of workers.slice(5)) w.finish(10);
    const again = j.start('period-1', { count: 1, seed: 100 });
    expect(again.offset).toBe(0);
    expect(again.runs[0]!.seed).toBe(100);
  });

  it('refuses to continue from variations that are gone', () => {
    const j = jobs(8);
    expect(() => j.start('period-1', { count: 1, continueAfter: 'batch-missing' })).toThrow(
      /generate from variation 1/,
    );
  });

  it('refuses a second Generate while one is running for the same period', () => {
    const j = jobs();
    j.start('period-1', { count: 2 });
    expect(() => j.start('period-1')).toThrow(/already running/);
  });

  it('replaces the previous variations with the next Generate', () => {
    const j = jobs(8);
    const first = j.start('period-1', { count: 1 });
    workers[0]!.finish(10);
    const second = j.start('period-1', { count: 1 });
    expect(j.status(first.id)).toBeUndefined();
    expect(j.current('period-1')!.id).toBe(second.id);
  });
});

describe('when the inputs move under a batch', () => {
  it('drops the candidates and says why once anything the solver read has changed', () => {
    const j = jobs(8);
    const batch = j.start('period-1', { count: 2 });
    workers[0]!.finish(10);
    workers[1]!.finish(20);
    inputVersion = 1; // leave approved since
    const current = j.current('period-1')!;
    expect(current.stale).toMatch(/changed since they were generated/);
    expect(current.best).toBeUndefined();
    expect(() => j.candidate(batch.id, 0)).toThrow(/changed since/);
  });

  it('stops the runs still going when it goes stale', () => {
    const j = jobs(3);
    j.start('period-1', { count: 4 });
    inputVersion = 1;
    const current = j.current('period-1')!;
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(current.state).toBe('done');
    expect(current.runs.every((r) => r.state === 'cancelled')).toBe(true);
  });

  it('stays usable while nothing the solver reads has changed', () => {
    const j = jobs(8);
    const batch = j.start('period-1', { count: 1 });
    workers[0]!.finish(10);
    expect(j.current('period-1')!.stale).toBeUndefined();
    expect(j.candidate(batch.id, 0).report.objective.total).toBe(10);
  });
});

describe('the estimate', () => {
  it('uses the last finished run of the same solver on the unit once there is one', () => {
    const j = jobs(3);
    expect(j.estimate('period-1', { count: 4 }).basis).toBe('rough');
    j.start('period-1', { count: 1 });
    workers[0]!.finish(500); // 1,500 ms
    const estimate = j.estimate('period-1', { count: 4 });
    // Four runs, two at a time: two rounds of 1.5 s.
    expect(estimate).toMatchObject({ basis: 'observed', perRunMs: 1500, totalMs: 3000 });
  });

  it('does not judge a longer search by a shorter one', () => {
    const j = jobs(3);
    j.start('period-1', { count: 1, maxIterations: 20_000 });
    workers[0]!.finish(500);
    expect(j.estimate('period-1', { count: 1, maxIterations: 20_000 }).basis).toBe('observed');
    expect(j.estimate('period-1', { count: 1 }).basis).toBe('rough');
  });
});
