/**
 * The slice of OR-Tools' CP-SAT protos this encoder emits and reads, as the JSON the runner
 * parses (native/cpsat-runner/runner.proto imports the real `CpModelProto`/`SatParameters`).
 *
 * Proto field names (snake_case) are used because protobuf's JSON parser accepts them and they
 * match the .proto files one-to-one. Numbers stay well inside ±2^53, so plain JSON numbers carry
 * every int64 exactly.
 */

/** A literal: a variable index, or `-(index + 1)` for its negation (CP-SAT's convention). */
export type Literal = number;

export interface CpIntegerVariable {
  /** Flattened [lo, hi, lo, hi, …] intervals; a plain variable is `[lo, hi]`. */
  domain: number[];
}

export interface CpLinearExpression {
  vars: number[];
  coeffs: number[];
  offset: number;
}

export type CpConstraint =
  | { linear: { vars: number[]; coeffs: number[]; domain: number[] } }
  | { at_most_one: { literals: Literal[] } }
  | { lin_max: { target: CpLinearExpression; exprs: CpLinearExpression[] } };

export interface CpObjective {
  vars: number[];
  coeffs: number[];
  /** Added to the sum before scaling: the objective's constant part. */
  offset: number;
  /** The reported objective is `scaling_factor * (sum + offset)` — here, back to points. */
  scaling_factor: number;
}

export interface CpModel {
  variables: CpIntegerVariable[];
  constraints: CpConstraint[];
  objective: CpObjective;
  /** A starting point for the search (e.g. the greedy seed); CP-SAT repairs it if it must. */
  solution_hint?: { vars: number[]; values: number[] };
}

/** The `SatParameters` fields this app sets. */
export interface CpParameters {
  num_workers?: number;
  random_seed?: number;
  /** Deterministic time budget: reproducible, unlike `max_time_in_seconds`. */
  max_deterministic_time?: number;
  max_time_in_seconds?: number;
  interleave_search?: boolean;
  log_search_progress?: boolean;
}

/** `CpSolverStatus` names, as the runner reports them. */
export type CpStatus = 'UNKNOWN' | 'MODEL_INVALID' | 'FEASIBLE' | 'INFEASIBLE' | 'OPTIMAL';
