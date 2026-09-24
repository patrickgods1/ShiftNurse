/**
 * The hybrid solver's pure half: a local search that can stop between annealing chunks and let
 * CP-SAT re-optimise a few days exactly.
 *
 * ## Why a hybrid
 *
 * On a whole period the annealer beats CP-SAT at this scale — CP-SAT's relaxation is weak and it
 * spends its budget proving little (M15 phase 4 measured it). But on a window of two or three
 * days, with every other shift held fixed, the model is a few hundred variables and CP-SAT solves
 * it to optimality in well under a second. That is exactly where annealing is weakest: a tangle
 * of rest rules across adjacent days that no sequence of single moves can untie. So the hybrid
 * anneals, then hands the worst window to CP-SAT, then anneals again.
 *
 * ## Why this is safe
 *
 * The window's answer goes into the live `SolverModel` through `canAdd`, like every annealer
 * move, and is kept only if the whole-period objective does not get worse; otherwise it is
 * rolled back exactly. The window model prices the whole period too — fairness and hours read
 * every fixed shift as a constant — so CP-SAT is choosing for the schedule, not just the window.
 *
 * Core cannot talk to the runner, so this class only builds the window's model and applies an
 * answer; the desktop's `ortools-solvers.ts` sends one to the other.
 */

import type { Assignment } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { type AnnealHooks, type AnnealResult, anneal } from './anneal.js';
import { type CpsatEncoding, encodeCpsat } from './cpsat/encode.js';
import { cpsatParameters } from './cpsat/params.js';
import type { CpModel, CpParameters } from './cpsat/proto.js';
import { greedySeed } from './greedy.js';
import { SolverModel } from './model.js';
import { buildReport } from './report.js';
import { Rng } from './rng.js';
import type { SolveInput, SolveOptions, SolveReport } from './types.js';

export interface HybridWindow {
  dateIdxs: readonly number[];
  dates: readonly IsoDate[];
}

export interface WindowJob {
  window: HybridWindow;
  model: CpModel;
  params: CpParameters;
  encoding: CpsatEncoding;
}

export interface WindowOutcome {
  /** True when the window's answer is now in the schedule. */
  improved: boolean;
  /** Objective change it would have made (negative is better). */
  delta: number;
}

export class LocalSearch {
  readonly model: SolverModel;
  private readonly rng: Rng;
  seedObjective = 0;

  constructor(
    private readonly input: SolveInput,
    private readonly options: SolveOptions,
  ) {
    this.model = new SolverModel(input, options.weights);
    this.rng = new Rng(options.seed);
  }

  seed(): void {
    greedySeed(this.model);
    this.seedObjective = this.model.objective();
  }

  /** Anneal iterations `from..to` of the run's cooling schedule. */
  anneal(from: number, to: number, hooks: AnnealHooks): AnnealResult {
    return anneal(this.model, this.rng, this.options, hooks, { from, to });
  }

  /**
   * A run of `days` consecutive dates, drawn with weight 1 + the coverage penalty on those days,
   * so understaffed stretches are chosen most but no stretch is ever unreachable.
   */
  pickWindow(days: number): HybridWindow {
    const { model } = this;
    const span = Math.min(days, model.dates.length);
    const perDay = model.dates.map(() => 0);
    for (const shift of model.shifts) perDay[shift.dateIdx]! += model.coveragePenaltyOf(shift);
    const starts = model.dates.length - span + 1;
    const weights = Array.from({ length: starts }, (_, s) => {
      let w = 1;
      for (let d = s; d < s + span; d++) w += perDay[d]!;
      return w;
    });
    const total = weights.reduce((t, w) => t + w, 0);
    let roll = this.rng.nextFloat() * total;
    let start = 0;
    while (start < starts - 1 && roll >= weights[start]!) roll -= weights[start++]!;
    const dateIdxs = Array.from({ length: span }, (_, i) => start + i);
    return { dateIdxs, dates: dateIdxs.map((d) => model.dates[d]!) };
  }

  /**
   * The CP-SAT model for one window: every shift outside it, as it stands now, is a locked
   * constant; the window's current shifts are the hint.
   */
  encodeWindow(window: HybridWindow, deterministicTime: number): WindowJob {
    const inWindow = new Set(window.dateIdxs);
    const current = this.model.assignments();
    const isOpen = (a: Assignment) => !a.isLocked && inWindow.has(this.model.dateIdx.get(a.date)!);
    const fixed: Assignment[] = current.map((a) => (isOpen(a) ? a : { ...a, isLocked: true }));
    const encoding = encodeCpsat(
      { ...this.input, assignments: fixed },
      {
        ...(this.options.weights ? { weights: this.options.weights } : {}),
        window: inWindow,
        hint: current.filter(isOpen),
      },
    );
    return {
      window,
      model: encoding.model,
      params: cpsatParameters({
        seed: Math.floor(this.rng.nextFloat() * 2 ** 31),
        deterministicTime,
      }),
      encoding,
    };
  }

  /**
   * Replace the window's unlocked shifts with CP-SAT's answer — through the rule gate, and only
   * if the whole-period objective does not get worse. Anything else is rolled back exactly.
   */
  applyWindow(job: WindowJob, values: readonly number[]): WindowOutcome {
    const { model } = this;
    if (values.length !== job.encoding.builder.variableCount) {
      throw new Error('CP-SAT returned a solution for a different window model');
    }
    const inWindow = new Set(job.window.dateIdxs);
    const before = model.objective();
    const removed = model.unlocked.filter((a) => inWindow.has(model.shiftOf(a).dateIdx));
    for (const a of removed) model.remove(a);
    const added: Assignment[] = [];
    const rollback = () => {
      for (let i = added.length - 1; i >= 0; i--) model.remove(added[i]!);
      for (const a of removed) model.add(a);
    };
    const chosen = job.encoding.shiftVars
      .filter((sv) => values[sv.variable] === 1)
      .sort((a, b) => a.shift.idx - b.shift.idx || a.n - b.n);
    for (const sv of chosen) {
      const candidate = model.make(sv.n, model.shifts[sv.shift.idx]!);
      if (!model.canAdd(sv.n, candidate)) {
        rollback();
        const nurse = model.nurses[sv.n]!;
        throw new Error(
          `CP-SAT put ${nurse.firstName} ${nurse.lastName} on the ${sv.shift.shiftType.name} on ` +
            `${sv.shift.date}, which breaks a hard rule: the CP-SAT encoding and the rule engine disagree.`,
        );
      }
      model.add(candidate);
      added.push(candidate);
    }
    const delta = model.objective() - before;
    if (delta > 1e-6) {
      rollback();
      return { improved: false, delta };
    }
    return { improved: delta < -1e-6, delta };
  }

  report(stats: SolveReport['stats']): SolveReport {
    return buildReport(this.model, stats);
  }
}
