/**
 * A small CP-SAT model builder that also knows how to *evaluate* what it built.
 *
 * ## Why an evaluator
 *
 * The encoding is a second statement of the rules and the objective. The only way to trust it
 * is to check it against the first statement — the rule engine and `SolverModel` — on the same
 * schedules, and that should not need a native binary. So every auxiliary variable is created
 * with the function that defines its value from the variables before it (a shortfall is
 * `max(0, required − staffed)`, a weekend indicator is "worked any shift that weekend"), and
 * `evaluate` fixes the decision variables, computes every auxiliary in creation order, checks
 * every constraint and prices the objective. Tests then assert: legal schedules satisfy the
 * encoding, illegal ones do not, and the encoded objective equals `SolverModel`'s.
 *
 * Auxiliaries that only ever appear in the objective with a positive cost are lower-bounded,
 * not pinned (the solver pushes them down to their definition); anything that feeds another
 * term with a negative sign is pinned exactly, or the solver could inflate it to lower the
 * objective elsewhere. The evaluator checks both kinds the same way: the defined value must
 * satisfy every constraint.
 */

import type { CpConstraint, CpLinearExpression, CpModel, Literal } from './proto.js';

/** `constant + Σ coeff·var`. Coefficients must be integers by the time they reach a constraint. */
export interface Expr {
  terms: [variable: number, coeff: number][];
  constant: number;
}

export function expr(terms: [number, number][] = [], constant = 0): Expr {
  return { terms, constant };
}

/** Sum of expressions, merging repeated variables. */
export function sum(...parts: Expr[]): Expr {
  const merged = new Map<number, number>();
  let constant = 0;
  for (const part of parts) {
    constant += part.constant;
    for (const [v, c] of part.terms) merged.set(v, (merged.get(v) ?? 0) + c);
  }
  return { terms: [...merged].filter(([, c]) => c !== 0), constant };
}

export function scale(e: Expr, k: number): Expr {
  return { terms: e.terms.map(([v, c]) => [v, c * k]), constant: e.constant * k };
}

type Values = (variable: number) => number;
type Definition = (value: Values) => number;

interface Check {
  label: string;
  holds: (value: Values) => boolean;
}

export interface Evaluation {
  /** Every variable's value: decisions as given, auxiliaries as defined. */
  values: number[];
  /** Objective in the model's reporting units (after `scaling_factor`). */
  objective: number;
  /** Labels of the constraints the assignment breaks. Empty means feasible. */
  violated: string[];
}

export class CpBuilder {
  private readonly variables: { lo: number; hi: number; label: string }[] = [];
  private readonly definitions: (Definition | undefined)[] = [];
  private readonly constraints: CpConstraint[] = [];
  private readonly checks: Check[] = [];
  private readonly objective = new Map<number, number>();
  private objectiveOffset = 0;

  get variableCount(): number {
    return this.variables.length;
  }

  label(variable: number): string {
    return this.variables[variable]!.label;
  }

  /** A decision variable: its value comes from the solver (or, when evaluating, the caller). */
  decision(label: string, lo = 0, hi = 1): number {
    this.variables.push({ lo, hi, label });
    this.definitions.push(undefined);
    return this.variables.length - 1;
  }

  /** An auxiliary variable whose value, given the variables before it, is `define`. */
  auxiliary(label: string, lo: number, hi: number, define: Definition): number {
    this.variables.push({ lo, hi, label });
    this.definitions.push(define);
    return this.variables.length - 1;
  }

  /** `lo ≤ e ≤ hi`. */
  linear(e: Expr, lo: number, hi: number, label: string): void {
    const terms = e.terms.filter(([, c]) => c !== 0);
    for (const [, c] of terms) assertInteger(c, label);
    const bound = (x: number) => (Number.isFinite(x) ? x - e.constant : x);
    this.constraints.push({
      linear: {
        vars: terms.map(([v]) => v),
        coeffs: terms.map(([, c]) => c),
        // Integer sums: a fractional bound rounds inward without changing the feasible set.
        domain: [clampBound(Math.ceil(bound(lo))), clampBound(Math.floor(bound(hi)))],
      },
    });
    this.checks.push({
      label,
      holds: (value) => {
        const x = evalExpr(e, value);
        return x >= lo - 1e-9 && x <= hi + 1e-9;
      },
    });
  }

  atMostOne(literals: Literal[], label: string): void {
    this.constraints.push({ at_most_one: { literals } });
    this.checks.push({
      label,
      holds: (value) => literals.filter((l) => literalValue(l, value) === 1).length <= 1,
    });
  }

  /** `target = max(exprs)`, exactly. */
  maxEquality(target: number, exprs: Expr[], label: string): void {
    for (const e of exprs) for (const [, c] of e.terms) assertInteger(c, label);
    this.constraints.push({
      lin_max: { target: toLinear(expr([[target, 1]])), exprs: exprs.map(toLinear) },
    });
    this.checks.push({
      label,
      holds: (value) => value(target) === Math.max(...exprs.map((e) => evalExpr(e, value))),
    });
  }

  /**
   * `e ≤ bound`, as a gate on the decision variables. Constants alone can already break it —
   * locked shifts and the lookback tail carry the violations they carry — and a model that says
   * "infeasible" because of a pinned past would leave the manager with nothing. So when the
   * constant part alone exceeds the bound, the constraint is replaced by forbidding every
   * variable that would add to it: the solver may not make a standing violation worse, which is
   * stricter than the rule engine's "no new violations" and so never produces an illegal roster.
   */
  atMost(e: Expr, bound: number, label: string): void {
    const live = e.terms.filter(([, c]) => c !== 0);
    if (live.length === 0) return;
    if (e.constant > bound + 1e-9) {
      for (const [v, c] of live)
        if (c > 0) this.linear(expr([[v, 1]]), 0, 0, `${label} (standing)`);
      return;
    }
    this.linear({ terms: live, constant: e.constant }, Number.NEGATIVE_INFINITY, bound, label);
  }

  /** The range `e` can take over its variables' domains. */
  bounds(e: Expr): [number, number] {
    let lo = e.constant;
    let hi = e.constant;
    for (const [v, c] of e.terms) {
      const d = this.variables[v]!;
      lo += c > 0 ? c * d.lo : c * d.hi;
      hi += c > 0 ? c * d.hi : c * d.lo;
    }
    return [lo, hi];
  }

  /**
   * An auxiliary `p ≥ max(0, e)`, lower-bounded only. For terms that are purely costs: the
   * solver drives `p` down to `max(0, e)`, which is also its definition here. Its range is what
   * `e` can actually reach — CP-SAT refuses a model whose objective could overflow int64, and a
   * tight range also helps its propagation.
   */
  positivePart(e: Expr, label: string): number {
    const hi = Math.max(0, Math.ceil(this.bounds(e)[1]));
    const p = this.auxiliary(label, 0, hi, (value) => Math.max(0, evalExpr(e, value)));
    this.linear(sum(expr([[p, 1]]), scale(e, -1)), 0, Number.POSITIVE_INFINITY, label);
    return p;
  }

  /** An auxiliary pinned to exactly `max(0, e)`: safe to use where it lowers another term. */
  exactPositivePart(e: Expr, label: string): number {
    const hi = Math.max(0, Math.ceil(this.bounds(e)[1]));
    const p = this.auxiliary(label, 0, hi, (value) => Math.max(0, evalExpr(e, value)));
    this.maxEquality(p, [e, expr()], label);
    return p;
  }

  /** A Boolean pinned to "any of these literals is true" (false for an empty list). */
  exactOr(literals: Literal[], label: string): number {
    const b = this.auxiliary(label, 0, 1, (value) =>
      literals.some((l) => literalValue(l, value) === 1) ? 1 : 0,
    );
    if (literals.length === 0) {
      this.linear(expr([[b, 1]]), 0, 0, label);
    } else {
      this.maxEquality(b, literals.map(literalExpr), label);
    }
    return b;
  }

  /** Add `weight · e` to the objective (weight may be fractional; rounded at build). */
  minimise(e: Expr, weight: number): void {
    this.objectiveOffset += e.constant * weight;
    for (const [v, c] of e.terms) this.objective.set(v, (this.objective.get(v) ?? 0) + c * weight);
  }

  /** The model, with objective coefficients scaled by `objectiveScale` and rounded. */
  build(objectiveScale: number): CpModel {
    const terms = [...this.objective]
      .map(([v, c]) => [v, Math.round(c * objectiveScale)] as const)
      .filter(([, c]) => c !== 0);
    return {
      variables: this.variables.map((v) => ({ domain: [v.lo, v.hi] })),
      constraints: this.constraints,
      objective: {
        vars: terms.map(([v]) => v),
        coeffs: terms.map(([, c]) => c),
        offset: this.objectiveOffset * objectiveScale,
        scaling_factor: 1 / objectiveScale,
      },
    };
  }

  /**
   * Fix the decision variables (unlisted ones are 0), derive every auxiliary, check every
   * constraint, and price the objective exactly as `build(objectiveScale)` would report it.
   */
  evaluate(decisions: ReadonlyMap<number, number>, objectiveScale: number): Evaluation {
    const values = new Array<number>(this.variables.length).fill(0);
    const value: Values = (v) => values[v]!;
    for (let v = 0; v < this.variables.length; v++) {
      const define = this.definitions[v];
      values[v] = define ? define(value) : (decisions.get(v) ?? 0);
    }
    const violated: string[] = [];
    for (const [v, spec] of this.variables.entries()) {
      if (values[v]! < spec.lo || values[v]! > spec.hi) violated.push(`${spec.label} out of range`);
    }
    for (const check of this.checks) if (!check.holds(value)) violated.push(check.label);
    const model = this.build(objectiveScale);
    let raw = model.objective.offset;
    for (const [i, v] of model.objective.vars.entries())
      raw += model.objective.coeffs[i]! * value(v);
    return { values, objective: raw * model.objective.scaling_factor, violated };
  }
}

export function literalValue(literal: Literal, value: Values): number {
  return literal >= 0 ? value(literal) : 1 - value(-literal - 1);
}

function literalExpr(literal: Literal): Expr {
  return literal >= 0 ? expr([[literal, 1]]) : expr([[-literal - 1, -1]], 1);
}

export function evalExpr(e: Expr, value: Values): number {
  let x = e.constant;
  for (const [v, c] of e.terms) x += c * value(v);
  return x;
}

function toLinear(e: Expr): CpLinearExpression {
  for (const [, c] of e.terms) assertInteger(c, 'linear expression');
  assertInteger(e.constant, 'linear expression offset');
  return { vars: e.terms.map(([v]) => v), coeffs: e.terms.map(([, c]) => c), offset: e.constant };
}

/** CP-SAT domains are int64; keep "unbounded" inside what JSON numbers carry exactly. */
const LIMIT = 2 ** 50;
function clampBound(x: number): number {
  if (x > LIMIT) return LIMIT;
  if (x < -LIMIT) return -LIMIT;
  return x;
}

function assertInteger(c: number, label: string): void {
  if (!Number.isInteger(c)) {
    throw new Error(`CP-SAT encoding: non-integer coefficient ${c} in "${label}"`);
  }
}
