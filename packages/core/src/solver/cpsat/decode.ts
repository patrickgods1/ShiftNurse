/**
 * CP-SAT's answer → a schedule, through the same gate every annealer move passes.
 *
 * The encoding is a second statement of the rules; the rule engine is the first. The answer is
 * loaded whole into a fresh `SolverModel`, then every nurse it touched is judged by the gate
 * (`gateBreaches`) on the roster she ends with, so a disagreement between the two can never
 * reach the grid: it throws `EncodingDisagreementError`, naming the nurse and the dates, and the
 * Generate dialog reports a failed solve instead of writing an illegal roster.
 *
 * Loaded whole, then judged per nurse — never row by row. A partial roster is not a schedule,
 * and judging one rejects a legal answer whenever a rule is not monotone under addition: the
 * prefix can break a rule the final roster keeps.
 */

import type { Id } from '../../domain/entities.js';
import type { IsoDate } from '../../domain/time.js';
import { nurseName, type Violation } from '../../rules/types.js';
import { SolverModel } from '../model.js';
import type { SolveInput } from '../types.js';
import type { CpsatEncoding } from './encode.js';

/** CP-SAT chose a roster the rule engine refuses: a defect in the encoding, never in the data. */
export class EncodingDisagreementError extends Error {
  readonly nurseId: Id;
  readonly breaches: readonly Violation[];

  constructor(
    nurseId: Id,
    name: string,
    dates: readonly IsoDate[],
    breaches: readonly Violation[],
  ) {
    super(
      `CP-SAT's answer for ${name} breaks a hard rule on ${dates.join(', ')}: ` +
        `${breaches.map((v) => v.message).join('; ')}. The CP-SAT encoding and the rule engine ` +
        'disagree — a bug in ShiftNurse, not in this schedule. Generate with SA + LNS until it ' +
        'is fixed, and please report it.',
    );
    this.name = 'EncodingDisagreementError';
    this.nurseId = nurseId;
    this.breaches = breaches;
  }
}

/**
 * Judge each nurse (ascending index) on the model as it now stands; the first the gate refuses
 * becomes the error, or null when every one passes. Shared by decode and the hybrid's windows,
 * so both judge final rosters the same way.
 */
export function firstDisagreement(
  model: SolverModel,
  nurseIdxs: Iterable<number>,
): EncodingDisagreementError | null {
  for (const n of [...nurseIdxs].sort((a, b) => a - b)) {
    const breaches = model.gateBreaches(n);
    if (breaches.length === 0) continue;
    // The breaches' own dates, plus the dates of the shifts CP-SAT placed that they name: a
    // pinned shift is the manager's, so naming its date would point at the wrong row.
    const named = new Set(breaches.flatMap((v) => v.assignmentIds));
    const placed = model
      .timeline(n)
      .filter((a) => named.has(a.id) && !model.isPinned(n, a.id))
      .map((a) => a.date);
    const dates = [...new Set([...breaches.flatMap((v) => v.dates), ...placed])].sort();
    const nurse = model.nurses[n]!;
    return new EncodingDisagreementError(nurse.id, nurseName(nurse), dates, breaches);
  }
  return null;
}

export function decodeCpsat(
  input: SolveInput,
  encoding: CpsatEncoding,
  values: readonly number[],
): SolverModel {
  if (values.length !== encoding.builder.variableCount) {
    throw new Error(
      `CP-SAT returned ${values.length} values for a model of ${encoding.builder.variableCount} variables`,
    );
  }
  const model = new SolverModel(input, encoding.weights);
  // Shift order fixes the `sol-N` ids and which nurse `ensureCharge` marks first.
  const chosen = encoding.shiftVars
    .filter((sv) => values[sv.variable] === 1)
    .sort((a, b) => a.shift.idx - b.shift.idx || a.n - b.n);
  for (const sv of chosen) model.add(model.make(sv.n, model.shifts[sv.shift.idx]!));
  const disagreement = firstDisagreement(model, new Set(chosen.map((sv) => sv.n)));
  if (disagreement) throw disagreement;
  return model;
}
