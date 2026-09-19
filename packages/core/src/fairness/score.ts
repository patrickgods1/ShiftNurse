/**
 * The per-nurse fairness score: a 0–100 composite with a component-by-component breakdown.
 *
 * Why a breakdown and not just a number: the score is what a manager reads out when a nurse
 * asks "why did I get another holiday?". Each component carries the two numbers that answer
 * that — what the nurse carried and what their fair share was — in a sentence, so the UI never
 * has to reverse-engineer an explanation from the maths.
 *
 * Everything relative (fair shares, team rates, the signed index) comes from `burden.ts`; this
 * module only turns deviations into points and weights them. Keeping that split is what makes
 * the score and the solver's burden index agree: they read the same deviations.
 */

import type { Id, Nurse } from '../domain/entities.js';
import { burdenFairShare, computeBurden } from './burden.js';
import { unitDistribution } from './distribution.js';
import { seniorityMultipliers } from './seniority.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type ComponentScore,
  DEFAULT_FAIRNESS_WEIGHTS,
  type EquityComponent,
  type FairnessReport,
  type FairnessWeights,
  type NurseBurden,
  type NurseFairnessScore,
  type ScoreInput,
} from './types.js';

/**
 * 100 at or under fair share, falling linearly to 0 at double the share. Linear so that the
 * score reads the same way the explanation does: "+50% over share" is 50 points, not some
 * curve the manager has to have explained.
 */
export function componentScore(deviation: number): number {
  return 100 * Math.min(1, Math.max(0, 1 - Math.max(0, deviation)));
}

const BURDEN_NOUN: Record<BurdenComponent, string> = {
  nights: 'night shifts',
  weekends: 'weekends',
  holidays: 'holidays',
  onCall: 'on-call shifts',
  undesirable: 'shifts against stated preferences',
  overtime: 'overtime hours',
};

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function signedPct(deviation: number): string {
  const value = Math.round(deviation * 100);
  return `${value >= 0 ? '+' : ''}${value}%`;
}

function burdenComponent(
  component: BurdenComponent,
  burden: NurseBurden,
  byNurse: ReadonlyMap<Id, NurseBurden>,
  weight: number,
): ComponentScore {
  const actual = burden.carried[BURDEN_COUNTER[component]];
  const deviation = burden.deviation[component];
  if (burden.shareWeight <= 0) {
    return {
      component,
      score: 100,
      weight,
      actual,
      expected: 0,
      deviation: 0,
      explanation: 'No contracted hours on record, so burden was not compared',
    };
  }
  const expected = burdenFairShare(byNurse, burden.nurseId, component);
  const noun = BURDEN_NOUN[component];
  const explanation =
    expected > 0
      ? `Carried ${actual.toFixed(1)} ${noun} against a fair share of ${expected.toFixed(1)} (${signedPct(deviation)})`
      : `Nobody on the team carried any ${noun}`;
  return {
    component,
    score: componentScore(deviation),
    weight,
    actual,
    expected,
    deviation,
    explanation,
  };
}

function equityComponent(
  component: EquityComponent,
  burden: NurseBurden,
  weight: number,
): ComponentScore {
  const deviation = burden.deviation[component];
  if (component === 'preferences') {
    const actual = burden.carried.preferenceHitRate;
    const expected = actual + deviation;
    const explanation = burden.hasRows
      ? `Preferences honoured ${pct(actual)} of the time; team average ${pct(expected)}`
      : 'No schedule on record yet, so preferences were not compared';
    return {
      component,
      score: componentScore(deviation),
      weight,
      actual,
      expected,
      deviation,
      explanation,
    };
  }
  const decisions = burden.carried.requestsApproved + burden.carried.requestsDenied;
  if (decisions === 0) {
    return {
      component,
      score: 100,
      weight,
      actual: 1,
      expected: 1,
      deviation: 0,
      explanation: 'No time-off decisions on record',
    };
  }
  const actual = burden.carried.requestsApproved / decisions;
  const expected = actual + deviation;
  return {
    component,
    score: componentScore(deviation),
    weight,
    actual,
    expected,
    deviation,
    explanation: `Time-off requests approved ${pct(actual)} of the time; team rate ${pct(expected)}`,
  };
}

function scoreNurse(
  nurse: Nurse,
  burden: NurseBurden,
  byNurse: ReadonlyMap<Id, NurseBurden>,
  weights: FairnessWeights,
  seniorityMultiplier: number,
): NurseFairnessScore {
  const components: ComponentScore[] = [];
  for (const component of BURDEN_COMPONENTS) {
    components.push(burdenComponent(component, burden, byNurse, weights[component]));
  }
  // Seniority scales how much an unmet preference costs — a multiplier on the weight, never a
  // different rule. A senior nurse with everything honoured scores the same 100 as anyone.
  components.push(
    equityComponent('preferences', burden, weights.preferences * seniorityMultiplier),
  );
  components.push(equityComponent('timeOff', burden, weights.timeOff));

  let weightTotal = 0;
  let weighted = 0;
  for (const c of components) {
    weightTotal += c.weight;
    weighted += c.weight * c.score;
  }
  const score = weightTotal > 0 ? Math.round((weighted / weightTotal) * 10) / 10 : 100;

  return {
    nurseId: nurse.id,
    score,
    components,
    seniorityMultiplier,
    burdenIndex: burden.index,
    comparable: burden.shareWeight > 0,
  };
}

export function scoreFairness(input: ScoreInput): FairnessReport {
  const weights = input.weights ?? DEFAULT_FAIRNESS_WEIGHTS;
  const burden = computeBurden(
    input.nurses,
    input.history,
    { ...input.burden, weights },
    input.current,
  );
  const multipliers = seniorityMultipliers(input.nurses, input.seniority);

  const scores = [...input.nurses]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((nurse) => {
      const nurseBurden = burden.byNurse.get(nurse.id);
      // computeBurden emits a row for every nurse it was given; a miss is a programming error.
      if (!nurseBurden) throw new Error(`No burden computed for nurse ${nurse.id}`);
      return scoreNurse(
        nurse,
        nurseBurden,
        burden.byNurse,
        weights,
        multipliers.get(nurse.id) ?? 1,
      );
    });

  return { scores, distribution: unitDistribution(burden, scores), weights };
}
