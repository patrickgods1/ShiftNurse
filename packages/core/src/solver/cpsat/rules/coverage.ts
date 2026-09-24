/**
 * `coverage-minimums` and `patient-ratio-compliance`, priced rather than enforced.
 *
 * Like the annealer, CP-SAT treats a shift-scope hard violation as a cost of `hardShortfall`
 * points per unit — a nurse short of a floor or a ratio is one unit per missing nurse; a missing
 * charge nurse, an all-novice roster or a missing credential is one unit each — because a unit
 * with too few eligible nurses must still get the best legal-per-nurse schedule, with every
 * shortfall named, rather than no schedule at all.
 */

import { NURSE_ROLES } from '../../../acuity/demand.js';
import type { Assignment, NurseRole } from '../../../domain/entities.js';
import {
  type CoverageParams,
  hasValidCredential,
  type RatioParams,
} from '../../../rules/coverage-rules.js';
import type { Shift } from '../../model.js';
import { type Expr, expr, scale, sum } from '../builder.js';
import type { EncodeContext, ShiftVar } from '../context.js';

/** Staff on a shift matching `keep`, variables and locked constants together. */
export function staffedExpr(
  ctx: EncodeContext,
  shift: Shift,
  keep: (nurseIdx: number, locked: Assignment | null) => boolean,
): Expr {
  const e = expr();
  for (const sv of ctx.byShift[shift.idx]!) if (keep(sv.n, null)) e.terms.push([sv.variable, 1]);
  for (const a of ctx.lockedByShift[shift.idx]!) if (keep(ctx.model.nurseOf(a), a)) e.constant += 1;
  return e;
}

export function roleExpr(ctx: EncodeContext, shift: Shift, role: NurseRole): Expr {
  return staffedExpr(ctx, shift, (n) => ctx.model.nurses[n]!.role === role);
}

function label(shift: Shift): string {
  return `${shift.shiftType.abbreviation} ${shift.date}`;
}

/** Shifts CP-SAT can change: the others are constants priced from the annealer's model. */
function variableShifts(ctx: EncodeContext): Shift[] {
  return ctx.model.shifts.filter((s) => ctx.byShift[s.idx]!.length > 0);
}

export function encodeCoverage(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as CoverageParams;
  const cost = ctx.weights.hardShortfall;
  for (const shift of variableShifts(ctx)) {
    const demand = shift.demand;
    if (!shift.shiftType.active || !demand) continue;

    for (const role of NURSE_ROLES) {
      const floor = demand.byRole[role]?.coverageFloorMin ?? 0;
      if (floor <= 0) continue;
      const short = ctx.b.positivePart(
        sum(expr([], floor), scale(roleExpr(ctx, shift, role), -1)),
        `understaffed: ${label(shift)} ${role}`,
      );
      ctx.b.minimise(expr([[short, 1]]), cost);
    }

    const requiresStaff = NURSE_ROLES.some((r) => (demand.byRole[r]?.minCount ?? 0) > 0);
    if (!requiresStaff || shift.shiftType.isOnCall) continue;
    const vars = ctx.byShift[shift.idx]!;
    const locked = ctx.lockedByShift[shift.idx]!;

    if (params.requireChargeNurse) missingCharge(ctx, shift, vars, locked, cost);

    if (params.minExperiencedPerShift > 0) {
      const experienced = staffedExpr(ctx, shift, (n) => !ctx.model.nurses[n]!.isNovice);
      shortOfAtLeast(
        ctx,
        vars,
        locked,
        experienced,
        params.minExperiencedPerShift,
        cost,
        `all novice: ${label(shift)}`,
      );
    }

    if (params.enforceCredentialRequirements) {
      for (const req of ctx.input.shiftCredentialRequirements) {
        if (req.shiftTypeId !== null && req.shiftTypeId !== shift.shiftType.id) continue;
        if (req.minCount <= 0) continue;
        const holders = staffedExpr(ctx, shift, (n) => {
          const nurse = ctx.model.nurses[n]!;
          if (req.role !== null && nurse.role !== req.role) return false;
          return hasValidCredential(ctx.model.ctx, nurse.id, req.credentialId, shift.date);
        });
        shortOfAtLeast(
          ctx,
          vars,
          locked,
          holders,
          req.minCount,
          cost,
          `credential ${req.credentialId}: ${label(shift)}`,
        );
      }
    }
  }
}

/**
 * The annealer gives the charge role to the first charge-eligible *unlocked* nurse on a shift
 * (`SolverModel.ensureCharge`), unless a locked row already carries the flag. So a shift has a
 * valid charge nurse when a locked row is flagged and eligible, or — no locked row being flagged
 * at all — when some eligible nurse is among the variables that are on.
 */
function missingCharge(
  ctx: EncodeContext,
  shift: Shift,
  vars: readonly ShiftVar[],
  locked: readonly Assignment[],
  cost: number,
): void {
  const flagged = locked.filter((a) => a.isCharge);
  if (flagged.some((a) => ctx.model.nurses[ctx.model.nurseOf(a)]!.isChargeEligible)) return;
  const eligible =
    flagged.length > 0 ? [] : vars.filter((sv) => ctx.model.nurses[sv.n]!.isChargeEligible);
  const b = ctx.b;
  const covered =
    eligible.length === 0
      ? null
      : b.auxiliary(`charge: ${label(shift)}`, 0, 1, (value) =>
          eligible.some((sv) => value(sv.variable) === 1) ? 1 : 0,
        );
  if (covered !== null) {
    b.linear(
      sum(expr([[covered, 1]]), expr(eligible.map((sv) => [sv.variable, -1]))),
      Number.NEGATIVE_INFINITY,
      0,
      `charge: ${label(shift)} needs an eligible nurse`,
    );
  }
  const coveredExpr = covered === null ? expr() : expr([[covered, 1]]);
  const missing = b.auxiliary(`missing charge: ${label(shift)}`, 0, 1, (value) => {
    const anyone = locked.length > 0 || vars.some((sv) => value(sv.variable) === 1);
    return anyone && (covered === null || value(covered) === 0) ? 1 : 0;
  });
  // missing ≥ (someone on) − covered, per person who could be on.
  for (const sv of vars) {
    b.linear(
      sum(
        expr([
          [missing, 1],
          [sv.variable, -1],
        ]),
        coveredExpr,
      ),
      0,
      Number.POSITIVE_INFINITY,
      `missing charge: ${label(shift)}`,
    );
  }
  if (locked.length > 0) {
    b.linear(
      sum(expr([[missing, 1]], -1), coveredExpr),
      0,
      Number.POSITIVE_INFINITY,
      `missing charge: ${label(shift)}`,
    );
  }
  b.minimise(expr([[missing, 1]]), cost);
}

/**
 * One unit when anyone is on the shift but fewer than `min` of them qualify:
 * `min·flag + qualified ≥ min·y` for everyone `y` who could be on.
 */
function shortOfAtLeast(
  ctx: EncodeContext,
  vars: readonly ShiftVar[],
  locked: readonly Assignment[],
  qualified: Expr,
  min: number,
  cost: number,
  name: string,
): void {
  const b = ctx.b;
  const flag = b.auxiliary(name, 0, 1, (value) => {
    const anyone = locked.length > 0 || vars.some((sv) => value(sv.variable) === 1);
    let q = qualified.constant;
    for (const [v, c] of qualified.terms) q += c * value(v);
    return anyone && q < min ? 1 : 0;
  });
  for (const sv of vars) {
    b.linear(
      sum(
        expr([
          [flag, min],
          [sv.variable, -min],
        ]),
        qualified,
      ),
      0,
      Number.POSITIVE_INFINITY,
      name,
    );
  }
  if (locked.length > 0) {
    b.linear(sum(expr([[flag, min]], -min), qualified), 0, Number.POSITIVE_INFINITY, name);
  }
  b.minimise(expr([[flag, 1]]), cost);
}

export function encodeRatio(ctx: EncodeContext, raw: Record<string, unknown>): void {
  const params = raw as unknown as RatioParams;
  for (const shift of variableShifts(ctx)) {
    const demand = shift.demand;
    if (!shift.shiftType.active || shift.shiftType.isOnCall || !demand) continue;
    if (params.skipShiftsWithoutForecast && demand.fromCoverageFloorOnly) continue;
    for (const role of NURSE_ROLES) {
      const required = demand.byRole[role]?.ratioDerived ?? 0;
      if (required <= 0) continue;
      const short = ctx.b.positivePart(
        sum(expr([], required), scale(roleExpr(ctx, shift, role), -1)),
        `ratio: ${label(shift)} ${role}`,
      );
      ctx.b.minimise(expr([[short, 1]]), ctx.weights.hardShortfall);
    }
  }
}
