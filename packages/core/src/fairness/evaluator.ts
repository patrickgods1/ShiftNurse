/**
 * Fairness scores for many versions of one period, cheaply — what the conflicts engine needs
 * when it prices every candidate fix ("approve this leave and cover with Ana: unit fairness
 * 82.4 → 81.9").
 *
 * `scoreFairness` answers the question once, with explanations, and was two thirds of a
 * conflicts analysis: each simulated fix re-grouped and re-sorted the whole ledger, re-folded
 * every nurse's history and wrote every explanation string. Here the history windows are built
 * once, a nurse's folded totals are reused whenever a fix left their period counters exactly as
 * they were, and only numbers are produced.
 *
 * The numbers must equal `scoreFairness`'s exactly — a card's "before" is the Fairness page's
 * score — so nothing is approximated: a reused interim was computed from identical inputs by the
 * same function, the team pass (`burdenByNurse`) runs over the whole roster every time because
 * every deviation depends on the team totals, and the composite is `compositeScore`, which
 * `scoreFairness` itself uses. `evaluator.test.ts` checks equality against `scoreFairness`.
 */

import type { FairnessLedgerEntry, Id, Nurse } from '../domain/entities.js';
import {
  buildInterim,
  burdenByNurse,
  type HistoryWindows,
  historyWindows,
  type NurseInterim,
} from './burden.js';
import { compositeScore } from './score.js';
import { seniorityMultipliers } from './seniority.js';
import {
  type BurdenCounters,
  type BurdenOptions,
  DEFAULT_BURDEN_OPTIONS,
  DEFAULT_FAIRNESS_WEIGHTS,
  EMPTY_COUNTERS,
  type FairnessWeights,
  type ScoreInput,
} from './types.js';

export interface FairnessEvaluatorInput {
  nurses: readonly Nurse[];
  history: readonly FairnessLedgerEntry[];
  weights?: FairnessWeights;
  burden?: ScoreInput['burden'];
  seniority?: ScoreInput['seniority'];
}

export interface FairnessScores {
  /** The unit score: the mean composite over nurses with a fair share to compare against. */
  mean: number;
  byNurse: ReadonlyMap<Id, number>;
}

/** A nurse's interims are remembered per distinct set of period counters, up to this many. */
const INTERIMS_PER_NURSE = 64;

const COUNTER_KEYS = Object.keys(EMPTY_COUNTERS) as (keyof BurdenCounters)[];

function counterKey(counters: BurdenCounters): string {
  return COUNTER_KEYS.map((key) => counters[key]).join('|');
}

export class FairnessEvaluator {
  private readonly nurses: readonly Nurse[];
  /** `scoreFairness` reports nurses in id order; the mean is summed in that order too. */
  private readonly byIdOrder: readonly Nurse[];
  private readonly windows: HistoryWindows;
  private readonly options: BurdenOptions;
  private readonly weights: FairnessWeights;
  private readonly multipliers: ReadonlyMap<Id, number>;
  private readonly interims = new Map<Id, Map<string, NurseInterim>>();

  constructor(input: FairnessEvaluatorInput) {
    this.nurses = input.nurses;
    this.byIdOrder = [...input.nurses].sort((a, b) => a.id.localeCompare(b.id));
    this.weights = input.weights ?? DEFAULT_FAIRNESS_WEIGHTS;
    this.options = { ...DEFAULT_BURDEN_OPTIONS, ...input.burden, weights: this.weights };
    this.windows = historyWindows(input.history, this.options.windowPeriods);
    this.multipliers = seniorityMultipliers(input.nurses, input.seniority);
  }

  /** Scores for one version of the period, given its counters (`deriveCounters`). */
  score(current: ReadonlyMap<Id, BurdenCounters>): FairnessScores {
    const interims = this.nurses.map((nurse) =>
      this.interimFor(nurse, current.get(nurse.id) ?? EMPTY_COUNTERS),
    );
    const burden = burdenByNurse(interims, this.options);

    const byNurse = new Map<Id, number>();
    let comparableTotal = 0;
    let comparableCount = 0;
    for (const nurse of this.byIdOrder) {
      const nurseBurden = burden.get(nurse.id);
      if (!nurseBurden) throw new Error(`No burden computed for nurse ${nurse.id}`);
      const score = compositeScore(nurseBurden, this.weights, this.multipliers.get(nurse.id) ?? 1);
      byNurse.set(nurse.id, score);
      if (nurseBurden.shareWeight > 0) {
        comparableTotal += score;
        comparableCount += 1;
      }
    }
    return { mean: comparableCount > 0 ? comparableTotal / comparableCount : 0, byNurse };
  }

  private interimFor(nurse: Nurse, counters: BurdenCounters): NurseInterim {
    let byKey = this.interims.get(nurse.id);
    if (!byKey) {
      byKey = new Map();
      this.interims.set(nurse.id, byKey);
    }
    const key = counterKey(counters);
    const cached = byKey.get(key);
    if (cached) return cached;
    if (byKey.size >= INTERIMS_PER_NURSE) byKey.clear();
    const interim = buildInterim(nurse, this.windows, this.options, counters);
    byKey.set(key, interim);
    return interim;
  }
}
