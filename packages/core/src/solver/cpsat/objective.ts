/**
 * The annealer's objective (`SolverModel.objective`), term for term, over the CP-SAT variables.
 *
 * Every term reads the same `SolverModel` tables — pay-period buckets and their pro-rata
 * targets, the historical burden and fair-share weights, preference and cost per (nurse, shift) —
 * so the two solvers optimise the same number; `encode.test.ts` checks they price a schedule
 * identically. Shifts and nurses with no variables are constants, priced by the model itself.
 *
 * Fairness here is the model's *linear* over-share: per burden component and nurse,
 * `max(0, carried − teamTotal · share / teamShare)`. The weekend and overtime counters feed
 * `teamTotal` with a negative sign for everyone else, so they are pinned exactly — a counter the
 * solver could inflate for an under-share nurse would lower everyone else's over-share.
 */

import { NURSE_ROLES } from '../../acuity/demand.js';
import type { Id } from '../../domain/entities.js';
import { type IsoDate, weekendKey } from '../../domain/time.js';
import { BURDEN_COMPONENTS, type BurdenComponent } from '../../fairness/types.js';
import { workedInHistory } from '../../rules/holiday-rotation.js';
import { groupInForce } from '../../rules/incompatibility-rules.js';
import { type Expr, evalExpr, expr, scale, sum } from './builder.js';
import { countExpr, type EncodeContext, HOURS, hoursExpr, type TimelineEntry } from './context.js';
import { isMovable, roleExpr } from './rules/coverage.js';

/** Fixed-point scale for fair-share arithmetic: shares are fractions of the team. */
const FAIR = 10_000;

export function encodeObjective(ctx: EncodeContext): void {
  coverageTerms(ctx);
  incompatibilityTerms(ctx);
  hoursTerms(ctx);
  fairnessTerms(ctx);
  holidayTerms(ctx);
  perShiftTerms(ctx);
}

/** `weight · max(0, e)`: a constant when nothing in `e` can move. */
function priced(ctx: EncodeContext, e: Expr, weight: number, label: string): void {
  if (weight === 0) return;
  if (e.terms.length === 0) {
    ctx.b.minimise(expr([], Math.max(0, e.constant)), weight);
    return;
  }
  ctx.b.minimise(expr([[ctx.b.positivePart(e, label), 1]]), weight);
}

function coverageTerms(ctx: EncodeContext): void {
  const { model, weights } = ctx;
  for (const shift of model.shifts) {
    if (!isMovable(ctx, shift)) {
      ctx.b.minimise(expr([], model.coveragePenaltyOf(shift)), 1);
      continue;
    }
    if (!shift.demand) continue;
    const at = `${shift.shiftType.abbreviation} ${shift.date}`;
    for (const role of NURSE_ROLES) {
      const target = shift.demand.byRole[role].targetCount;
      const staffed = roleExpr(ctx, shift, role);
      priced(
        ctx,
        sum(expr([], target), scale(staffed, -1)),
        weights.targetShortfall,
        `below target: ${at} ${role}`,
      );
      priced(
        ctx,
        sum(staffed, expr([], -target)),
        weights.overTarget,
        `over target: ${at} ${role}`,
      );
    }
  }
}

/**
 * Incompatible staff, stretch by stretch, as `SolverModel.incompatibilityPenalty` prices them
 * with `judgeFloor`: per group, members beyond the cap, and — while two or more members overlap —
 * outside staff short of the minimum, each per person-hour. A stretch with no variables on it is
 * the model's own constant. Both rules are priced here whatever their severity, which is why
 * `CPSAT_ENCODERS` has nothing to add for them.
 */
function incompatibilityTerms(ctx: EncodeContext): void {
  const { model } = ctx;
  const { excess, shortfall, minOutsideStaff } = model.incompatibilityPrice;
  for (const stretch of model.stretches) {
    const floor: { nurseId: Id; date: IsoDate; literal: number | null }[] = [];
    for (const shift of stretch.shifts) {
      for (const sv of ctx.byShift[shift.idx]!) {
        floor.push({ nurseId: sv.nurseId, date: shift.date, literal: sv.variable });
      }
      for (const a of ctx.lockedByShift[shift.idx]!) {
        floor.push({ nurseId: a.nurseId, date: a.date, literal: null });
      }
    }
    for (const a of stretch.tail) floor.push({ nurseId: a.nurseId, date: a.date, literal: null });
    if (floor.every((f) => f.literal === null)) {
      ctx.b.minimise(expr([], model.incompatibilityPenaltyOf(stretch)), 1);
      continue;
    }
    for (const group of model.incompatibilityGroups) {
      const members = expr();
      const outside = expr();
      for (const f of floor) {
        const side =
          group.nurseIds.includes(f.nurseId) && groupInForce(group, f.date) ? members : outside;
        if (f.literal === null) side.constant += 1;
        else side.terms.push([f.literal, 1]);
      }
      const [lo, hi] = ctx.b.bounds(members);
      if (hi < 2) continue;
      const label = `incompatible ${group.id}: stretch ${stretch.idx}`;
      if (excess > 0) {
        priced(ctx, sum(members, expr([], -group.maxTogether)), excess * stretch.hours, label);
      }
      if (shortfall > 0 && minOutsideStaff > 0) {
        let together: Expr;
        if (lo >= 2) {
          together = expr([], 1);
        } else {
          const t = ctx.b.auxiliary(`${label} together`, 0, 1, (value) =>
            evalExpr(members, value) >= 2 ? 1 : 0,
          );
          // Two or more members force `t` on: members − 1 ≤ (hi − 1)·t.
          ctx.b.linear(
            sum(members, expr([[t, -(hi - 1)]], -1)),
            Number.NEGATIVE_INFINITY,
            0,
            `${label} together`,
          );
          together = expr([[t, 1]]);
        }
        priced(
          ctx,
          sum(scale(together, minOutsideStaff), scale(outside, -1)),
          shortfall * stretch.hours,
          `${label} outside staff`,
        );
      }
    }
  }
}

function hoursTerms(ctx: EncodeContext): void {
  const { model, weights } = ctx;
  for (let n = 0; n < model.nurses.length; n++) {
    if (!model.hoursCapped[n]) continue;
    if (ctx.byNurse[n]!.length === 0) {
      ctx.b.minimise(expr([], model.hoursPenaltyOf(n)), 1);
      continue;
    }
    const counted = ctx
      .timeline(n)
      .filter(
        (e) => e.inPeriod && (!e.shiftType.isOnCall || model.fteParams.onCallCountsTowardHours),
      );
    for (const [bucket, target] of model.hoursTarget[n]!.entries()) {
      const inBucket = counted.filter((e) => model.bucketOfDate[e.shift!.dateIdx] === bucket);
      const short = sum(expr([], Math.round(target * HOURS)), scale(hoursExpr(inBucket), -1));
      priced(
        ctx,
        short,
        weights.underHours / HOURS,
        `under hours: ${ctx.name(n)} bucket ${bucket}`,
      );
    }
  }
}

function fairnessTerms(ctx: EncodeContext): void {
  const { model, input, weights } = ctx;
  if (model.teamShare <= 0 || weights.fairness === 0) return;
  const team = model.candidates.filter((n) => model.shareWeight[n]! > 0);
  const inPeriod = new Map(team.map((n) => [n, ctx.timeline(n).filter((e) => e.inPeriod)]));

  // Shares as exact integers: contracted hours usually are already; a history-average share may
  // need a power of ten. Multiplying through by the team share (instead of dividing by it) keeps
  // every coefficient exact — rounding `share / teamShare` per term was off by whole points once
  // multiplied by overtime counted in hundredths of an hour.
  const unit = shareUnit(team.map((n) => model.shareWeight[n]!));
  const share = new Map(team.map((n) => [n, Math.round(model.shareWeight[n]! * unit)]));
  const teamShare = [...share.values()].reduce((t, x) => t + x, 0);

  for (const component of BURDEN_COMPONENTS) {
    const w = input.ruleSet.fairnessWeights[component];
    if (w <= 0) continue;
    const carried = new Map<number, Expr>(
      team.map((n) => [
        n,
        sum(
          expr([], model.histCarried[n]![component]),
          current(ctx, n, component, inPeriod.get(n)!),
        ),
      ]),
    );
    const teamTotal = pinnedTeamTotal(ctx, [...carried.values()], component);
    for (const n of team) {
      // FAIR·over = FAIR·(carried − teamTotal·share/teamShare), times teamShare to stay integral.
      const scaled = scale(
        sum(scale(carried.get(n)!, teamShare), scale(teamTotal, -share.get(n)!)),
        FAIR,
      );
      const label = `over share: ${ctx.name(n)} ${component}`;
      if (scaled.terms.length === 0) {
        ctx.b.minimise(
          expr([], Math.max(0, scaled.constant / teamShare)),
          (weights.fairness * w) / FAIR,
        );
        continue;
      }
      const terms = scaled.terms.map(([v, c]) => [v, Math.round(c)] as [number, number]);
      const hi = Math.max(
        0,
        Math.ceil(ctx.b.bounds({ terms, constant: scaled.constant })[1] / teamShare),
      );
      const over = ctx.b.auxiliary(label, 0, hi, (value) =>
        Math.max(
          0,
          Math.ceil(evalExpr({ terms, constant: scaled.constant }, value) / teamShare - 1e-9),
        ),
      );
      // teamShare·over ≥ scaled, over ≥ 0: the smallest such `over` is ⌈scaled / teamShare⌉.
      ctx.b.linear(
        sum(expr([[over, teamShare]]), scale({ terms, constant: scaled.constant }, -1)),
        0,
        Number.POSITIVE_INFINITY,
        label,
      );
      ctx.b.minimise(expr([[over, 1]]), (weights.fairness * w) / FAIR);
    }
  }
}

/**
 * The team's total burden as `constant + T/HOURS` with one pinned variable `T`, so each nurse's
 * over-share constraint mentions `T` once instead of every shift on the team: 42 nurses × six
 * components × every variable would otherwise be millions of coefficients.
 */
function pinnedTeamTotal(ctx: EncodeContext, carried: readonly Expr[], component: string): Expr {
  const total = sum(...carried);
  if (total.terms.length === 0) return total;
  // HOURS·(variable part) is integral: counts have coefficient 1, overtime 1/HOURS.
  const moving = scale({ terms: total.terms, constant: 0 }, HOURS);
  const terms = moving.terms.map(([v, c]) => [v, Math.round(c)] as [number, number]);
  const [lo, hi] = ctx.b.bounds({ terms, constant: 0 });
  const t = ctx.b.auxiliary(`team total: ${component}`, Math.floor(lo), Math.ceil(hi), (value) =>
    evalExpr({ terms, constant: 0 }, value),
  );
  ctx.b.linear(
    sum(expr([[t, 1]]), scale({ terms, constant: 0 }, -1)),
    0,
    0,
    `team total: ${component}`,
  );
  return expr([[t, 1 / HOURS]], total.constant);
}

/** The smallest power of ten (≤ 10 000) that makes every share an integer. */
function shareUnit(shares: readonly number[]): number {
  for (const unit of [1, 10, 100, 1000, 10_000]) {
    if (shares.every((x) => Math.abs(x * unit - Math.round(x * unit)) < 1e-9)) return unit;
  }
  return 10_000;
}

/** This period's counter for one burden component, as `SolverModel.current` defines it. */
function current(
  ctx: EncodeContext,
  n: number,
  component: BurdenComponent,
  entries: readonly TimelineEntry[],
): Expr {
  const { model } = ctx;
  const worked = entries.filter((e) => !e.shiftType.isOnCall);
  switch (component) {
    case 'nights':
      return countExpr(worked.filter((e) => e.shiftType.isNight));
    case 'holidays':
      return countExpr(worked.filter((e) => model.ctx.holidayDates.has(e.date)));
    case 'onCall':
      return countExpr(entries.filter((e) => e.shiftType.isOnCall));
    case 'undesirable':
      return countExpr(worked.filter((e) => model.isUndesirable(n, e.shift!)));
    case 'weekends': {
      const byKey = new Map<string, TimelineEntry[]>();
      for (const e of worked) {
        const key = weekendKey(e.window, model.ctx.weekendDefinition);
        if (key !== null) byKey.set(key, [...(byKey.get(key) ?? []), e]);
      }
      const e = expr();
      for (const [key, list] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
        if (list.some((x) => x.literal === null)) e.constant += 1;
        else if (list.length === 1) e.terms.push([list[0]!.literal!, 1]);
        else
          e.terms.push([
            ctx.b.exactOr(
              list.map((x) => x.literal!),
              `weekend ${key}: ${ctx.name(n)}`,
            ),
            1,
          ]);
      }
      return e;
    }
    case 'overtime': {
      const over = sum(
        hoursExpr(worked),
        expr([], -Math.round(model.contractedProRata[n]! * HOURS)),
      );
      if (over.terms.length === 0) return expr([], Math.max(0, over.constant) / HOURS);
      const ot = ctx.b.exactPositivePart(over, `overtime: ${ctx.name(n)}`);
      // In hours; FAIR/HOURS is integral, so the fair-share constraint stays integral.
      return expr([[ot, 1 / HOURS]]);
    }
  }
}

/**
 * The holiday rotation, as `SolverModel.countHolidayRotation` counts it: each worked shift on a
 * holiday the nurse is owed off, and each pair a nurse works both halves of. Priced only while
 * the rule is soft (`holidayPrice`); a hard rule is `encodeHolidayRotation`'s constraints.
 */
function holidayTerms(ctx: EncodeContext): void {
  const { model, input } = ctx;
  const price = model.holidayPrice;
  if (price === 0) return;
  const facts = model.holidayFacts;
  for (let n = 0; n < model.nurses.length; n++) {
    const worked = ctx.timeline(n).filter((e) => !e.shiftType.isOnCall);
    const owed = facts.owedOff.get(model.nurses[n]!.id);
    if (owed) {
      ctx.b.minimise(countExpr(worked.filter((e) => e.inPeriod && owed.has(e.date))), price);
    }
    const nurseId = model.nurses[n]!.id;
    const start = input.period.startDate;
    for (const { minor, major } of facts.pairs) {
      const label = `holiday pair: ${ctx.name(n)} ${minor.date}/${major.date}`;
      // A half behind the period may be on record rather than on the timeline.
      const [onMinor, onMajor] = [minor, major].map((h) =>
        workedInHistory(model.ctx, nurseId, h, start)
          ? expr([], 1)
          : worked.some((e) => e.date === h.date)
            ? anyOf(
                ctx,
                worked.filter((e) => e.date === h.date),
                label,
              )
            : undefined,
      );
      if (onMinor === undefined || onMajor === undefined) continue;
      priced(ctx, sum(onMinor, onMajor, expr([], -1)), price, label);
    }
  }
}

/** 1 when any of these entries is worked: a constant if one is, else their Boolean or. */
function anyOf(ctx: EncodeContext, entries: readonly TimelineEntry[], label: string): Expr {
  if (entries.some((e) => e.literal === null)) return expr([], 1);
  if (entries.length === 1) return expr([[entries[0]!.literal!, 1]]);
  return expr([
    [
      ctx.b.exactOr(
        entries.map((e) => e.literal!),
        `${label} any`,
      ),
      1,
    ],
  ]);
}

/** Preferences and straight-time cost: a fixed price per (nurse, shift), locked shifts included. */
function perShiftTerms(ctx: EncodeContext): void {
  const { model, weights } = ctx;
  for (const sv of ctx.shiftVars) {
    const price =
      model.preferencePenalty(sv.n, sv.shift) * weights.preference +
      model.shiftCostFor(sv.n, sv.shift) * weights.cost;
    if (price !== 0) ctx.b.minimise(expr([[sv.variable, 1]]), price);
  }
  for (const [n, locked] of ctx.lockedByNurse.entries()) {
    for (const a of locked) {
      const shift = model.shiftOf(a);
      ctx.b.minimise(
        expr(
          [],
          model.preferencePenalty(n, shift) * weights.preference +
            model.shiftCostFor(n, shift) * weights.cost,
        ),
        1,
      );
    }
  }
}
