/**
 * CP-SAT's answer → a schedule, through the same gate every annealer move passes.
 *
 * The encoding is a second statement of the rules; the rule engine is the first. Loading the
 * answer into a fresh `SolverModel` with `canAdd` on every shift means a disagreement between
 * the two can never reach the grid: it throws, naming the nurse and the shift, and the Generate
 * dialog reports a failed solve instead of writing an illegal roster.
 */

import { SolverModel } from '../model.js';
import type { SolveInput } from '../types.js';
import type { CpsatEncoding } from './encode.js';

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
  const chosen = encoding.shiftVars
    .filter((sv) => values[sv.variable] === 1)
    .sort((a, b) => a.shift.idx - b.shift.idx || a.n - b.n);
  for (const sv of chosen) {
    const shift = model.shifts[sv.shift.idx]!;
    const nurse = model.nurses[sv.n]!;
    const candidate = model.make(sv.n, shift);
    if (!model.canAdd(sv.n, candidate)) {
      throw new Error(
        `CP-SAT put ${nurse.firstName} ${nurse.lastName} on the ${shift.shiftType.name} on ` +
          `${shift.date}, which breaks a hard rule: the CP-SAT encoding and the rule engine disagree.`,
      );
    }
    model.add(candidate);
  }
  return model;
}
