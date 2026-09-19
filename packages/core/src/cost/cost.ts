/**
 * Schedule costing — prices every in-period assignment, rolls the result up per nurse and for
 * the unit, and prices a single candidate assignment in context.
 *
 * See `types.ts` for the pay model this implements. The one structural point worth restating:
 * overtime is a property of a nurse's *week*, not of a shift, so costing walks each nurse's
 * full timeline (lookback tail included, exactly as the max-hours rule does) before any shift
 * can be priced. That is also why `marginalCost` re-costs the nurse rather than pricing the
 * candidate in isolation — the shift you add on Sunday can turn Wednesday into overtime.
 */

import type { Assignment, Differential, DifferentialKind, Id } from '../domain/entities.js';
import { addDays, type IsoDate, isWeekendWindow, weekdayOf } from '../domain/time.js';
import { gini } from '../fairness/distribution.js';
import { isWorked } from '../rules/types.js';
import { type AssignmentView, ScheduleView } from '../schedule/view.js';
import { resolvePayRate } from './rates.js';
import {
  type AssignmentCost,
  type BudgetVariance,
  type CostContext,
  type CostLine,
  type CostLineKind,
  type CostTotals,
  DIFFERENTIAL_ORDER,
  type MarginalCost,
  type NurseCost,
  type NurseOvertime,
  type OvertimeConcentration,
  type ScheduleCost,
} from './types.js';

// ---------------------------------------------------------------------------
// Overtime attribution
// ---------------------------------------------------------------------------

interface OvertimeShare {
  hours: number;
  multiplier: number;
}

/** Overtime hours per worked in-period view under a daily rule: whatever exceeds the threshold. */
function dailyOvertime(
  timeline: readonly AssignmentView[],
  threshold: number,
): Map<AssignmentView, number> {
  const out = new Map<AssignmentView, number>();
  for (const view of timeline) {
    if (!view.inPeriod || !isWorked(view)) continue;
    const over = view.paidHours - threshold;
    if (over > 0) out.set(view, over);
  }
  return out;
}

/** The date a work week containing `date` starts on. */
function workWeekStart(date: IsoDate, startsOn: number): IsoDate {
  return addDays(date, -((weekdayOf(date) - startsOn + 7) % 7));
}

/**
 * Overtime hours per worked in-period view under a weekly rule. Hours accrue in chronological
 * order — the timeline is sorted by shift start — so the tail's hours consume the threshold
 * first and only the shifts that cross it carry overtime. Tail views accrue but are never
 * attributed overtime: a previous period's shift is not this schedule's cost.
 */
function weeklyOvertime(
  timeline: readonly AssignmentView[],
  threshold: number,
  startsOn: number,
): Map<AssignmentView, number> {
  const out = new Map<AssignmentView, number>();
  const runningByWeek = new Map<IsoDate, number>();
  for (const view of timeline) {
    if (!isWorked(view)) continue;
    const week = workWeekStart(view.assignment.date, startsOn);
    const before = runningByWeek.get(week) ?? 0;
    const after = before + view.paidHours;
    runningByWeek.set(week, after);
    if (!view.inPeriod) continue;
    const over = after - Math.max(threshold, before);
    if (over > 0) out.set(view, over);
  }
  return out;
}

/**
 * The overtime each in-period view carries once every active rule has had its say. An hour is
 * overtime once: where rules disagree, the one paying the larger premium for that shift wins.
 * Comparing `hours × (multiplier − 1)` is enough because a shift's straight rate is the same
 * under either rule.
 */
function attributeOvertime(
  timeline: readonly AssignmentView[],
  ctx: CostContext,
): Map<AssignmentView, OvertimeShare> {
  const best = new Map<AssignmentView, OvertimeShare>();
  for (const rule of ctx.overtimeRules) {
    const hoursByView =
      rule.basis === 'daily'
        ? dailyOvertime(timeline, rule.thresholdHours)
        : weeklyOvertime(timeline, rule.thresholdHours, ctx.workWeekStartsOn);
    for (const [view, hours] of hoursByView) {
      const candidate = { hours, multiplier: rule.multiplier };
      const current = best.get(view);
      const premiumOf = (s: OvertimeShare) => s.hours * (s.multiplier - 1);
      if (!current || premiumOf(candidate) > premiumOf(current)) best.set(view, candidate);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pricing one shift
// ---------------------------------------------------------------------------

function differentialOf(ctx: CostContext, kind: DifferentialKind): Differential | undefined {
  return ctx.differentials.find((d) => d.kind === kind && d.active);
}

/** Which differentials a *worked* shift earns, in itemisation order. */
function applicableDifferentials(view: AssignmentView, ctx: CostContext): Differential[] {
  const applies: Record<DifferentialKind, boolean> = {
    night: view.shiftType.isNight,
    weekend: isWeekendWindow(view.window, ctx.weekendDefinition),
    // Dated by start day, same as the fairness ledger: the night into a holiday morning is
    // not a holiday shift.
    holiday: ctx.holidayDates.has(view.assignment.date),
    charge: view.assignment.isCharge,
    agency: view.nurse.employmentType === 'agency',
    // Standby is priced separately; call-back is a day-of event with no assignment to hang on.
    on_call: false,
    call_back: false,
  };
  const out: Differential[] = [];
  for (const kind of DIFFERENTIAL_ORDER) {
    if (!applies[kind]) continue;
    const d = differentialOf(ctx, kind);
    if (d) out.push(d);
  }
  return out;
}

function sum(lines: readonly CostLine[]): number {
  let total = 0;
  for (const line of lines) total += line.amount;
  return total;
}

function priceView(
  view: AssignmentView,
  ctx: CostContext,
  overtime: OvertimeShare | undefined,
): AssignmentCost {
  const hours = view.paidHours;
  const identity = {
    assignmentId: view.assignment.id,
    nurseId: view.assignment.nurseId,
    shiftTypeId: view.assignment.shiftTypeId,
    date: view.assignment.date,
    hours,
  };

  const resolved = resolvePayRate(ctx.payRates, view.nurse, view.assignment.date);
  if (!resolved) {
    return {
      ...identity,
      baseRate: 0,
      rateSource: 'none',
      straightRate: 0,
      overtimeHours: 0,
      lines: [],
      total: 0,
    };
  }
  const base = resolved.rate.hourlyRate;

  if (view.shiftType.isOnCall) {
    // Standby earns the on-call differential alone. A unit with no on-call differential
    // configured prices standby at $0 — visibly, as a zero line, not by vanishing.
    const d = differentialOf(ctx, 'on_call');
    const rate = d === undefined ? 0 : d.mode === 'flat' ? d.amount : base * d.amount;
    const line: CostLine = { kind: 'on_call', hours, rate, amount: hours * rate };
    return {
      ...identity,
      baseRate: base,
      rateSource: resolved.source,
      straightRate: rate,
      overtimeHours: 0,
      lines: [line],
      total: line.amount,
    };
  }

  const lines: CostLine[] = [{ kind: 'base', hours, rate: base, amount: hours * base }];
  let running = base;
  const applicable = applicableDifferentials(view, ctx);
  for (const d of applicable) {
    if (d.mode !== 'flat') continue;
    lines.push({ kind: d.kind, hours, rate: d.amount, amount: hours * d.amount });
    running += d.amount;
  }
  for (const d of applicable) {
    if (d.mode !== 'multiplier') continue;
    // Itemised as the increment this multiplier adds to the running rate, so the lines sum
    // to the total and a 1.0× multiplier shows as a $0 line rather than disappearing.
    const increment = running * (d.amount - 1);
    lines.push({ kind: d.kind, hours, rate: increment, amount: hours * increment });
    running *= d.amount;
  }
  const straightRate = running;

  let overtimeHours = 0;
  if (overtime && overtime.hours > 0) {
    overtimeHours = overtime.hours;
    const rate = straightRate * (overtime.multiplier - 1);
    lines.push({ kind: 'overtime', hours: overtimeHours, rate, amount: overtimeHours * rate });
  }

  return {
    ...identity,
    baseRate: base,
    rateSource: resolved.source,
    straightRate,
    overtimeHours,
    lines,
    total: sum(lines),
  };
}

/** Every in-period assignment of one nurse, priced with overtime attributed across their week. */
function costTimeline(timeline: readonly AssignmentView[], ctx: CostContext): AssignmentCost[] {
  const overtime = attributeOvertime(timeline, ctx);
  const out: AssignmentCost[] = [];
  for (const view of timeline) {
    if (!view.inPeriod) continue;
    out.push(priceView(view, ctx, overtime.get(view)));
  }
  return out;
}

/** One nurse's in-period assignments, priced. Chronological. */
export function costNurse(schedule: ScheduleView, ctx: CostContext, nurseId: Id): AssignmentCost[] {
  return costTimeline(schedule.timelineFor(nurseId), ctx);
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

const LINE_KINDS: readonly CostLineKind[] = ['base', ...DIFFERENTIAL_ORDER, 'overtime'];

function emptyTotals(): CostTotals {
  const byKind = {} as Record<CostLineKind, number>;
  for (const kind of LINE_KINDS) byKind[kind] = 0;
  return {
    hours: 0,
    overtimeHours: 0,
    base: 0,
    differentials: 0,
    overtimePremium: 0,
    total: 0,
    byKind,
  };
}

function accumulate(into: CostTotals, cost: AssignmentCost): void {
  into.hours += cost.hours;
  into.overtimeHours += cost.overtimeHours;
  into.total += cost.total;
  for (const line of cost.lines) {
    into.byKind[line.kind] += line.amount;
    if (line.kind === 'base') into.base += line.amount;
    else if (line.kind === 'overtime') into.overtimePremium += line.amount;
    else into.differentials += line.amount;
  }
}

function concentration(nurses: readonly NurseCost[]): OvertimeConcentration {
  const totalHours = nurses.reduce((acc, n) => acc + n.overtimeHours, 0);
  const totalPremium = nurses.reduce((acc, n) => acc + n.overtimePremium, 0);
  const ranked: NurseOvertime[] = nurses
    .filter((n) => n.overtimeHours > 0)
    .map((n) => ({
      nurseId: n.nurseId,
      hours: n.overtimeHours,
      premium: n.overtimePremium,
      share: totalHours === 0 ? 0 : n.overtimeHours / totalHours,
    }))
    .sort((a, b) => b.hours - a.hours || (a.nurseId < b.nurseId ? -1 : 1));
  return {
    totalHours,
    totalPremium,
    ranked,
    nursesWithOvertime: ranked.length,
    topThreeShare: ranked.slice(0, 3).reduce((acc, r) => acc + r.share, 0),
    gini: gini(nurses.map((n) => n.overtimeHours)),
  };
}

/** Price a whole period. Only in-period assignments are costed; the lookback tail is context. */
export function costSchedule(schedule: ScheduleView, ctx: CostContext): ScheduleCost {
  const assignments: AssignmentCost[] = [];
  const nurses: NurseCost[] = [];
  const totals = emptyTotals();
  const unpricedNurseIds: Id[] = [];

  for (const nurseId of schedule.nursesById.keys()) {
    const costs = costNurse(schedule, ctx, nurseId);
    if (costs.length === 0) continue;
    const nurse: NurseCost = { ...emptyTotals(), nurseId, assignments: 0, unpricedAssignments: 0 };
    for (const cost of costs) {
      nurse.assignments++;
      if (cost.rateSource === 'none') nurse.unpricedAssignments++;
      accumulate(nurse, cost);
      accumulate(totals, cost);
      assignments.push(cost);
    }
    if (nurse.unpricedAssignments > 0) unpricedNurseIds.push(nurseId);
    nurses.push(nurse);
  }

  nurses.sort((a, b) => b.total - a.total || (a.nurseId < b.nurseId ? -1 : 1));
  unpricedNurseIds.sort();
  // Per-nurse costing walks each timeline in turn; restore schedule order for the flat list.
  const order = new Map(schedule.assignments().map((v, i) => [v.assignment.id, i]));
  assignments.sort((a, b) => (order.get(a.assignmentId) ?? 0) - (order.get(b.assignmentId) ?? 0));

  return {
    periodId: schedule.period.id,
    assignments,
    nurses,
    totals,
    unpricedAssignments: nurses.reduce((acc, n) => acc + n.unpricedAssignments, 0),
    unpricedNurseIds,
    overtime: concentration(nurses),
  };
}

// ---------------------------------------------------------------------------
// Candidate pricing
// ---------------------------------------------------------------------------

/**
 * What adding `candidate` would cost. The nurse is re-costed with and without it on a view
 * containing only their own timeline, so the price of one candidate does not scale with the
 * size of the unit. The candidate must carry an id that is not already on the schedule.
 */
export function marginalCost(
  schedule: ScheduleView,
  ctx: CostContext,
  candidate: Assignment,
): MarginalCost {
  const nurse = schedule.nursesById.get(candidate.nurseId);
  if (!nurse) throw new Error(`Candidate references unknown nurse ${candidate.nurseId}`);
  const timeline = schedule.timelineFor(candidate.nurseId);
  const before = costTimeline(timeline, ctx).reduce((acc, c) => acc + c.total, 0);

  const withCandidate = new ScheduleView({
    period: schedule.period,
    assignments: [...timeline.filter((v) => v.inPeriod).map((v) => v.assignment), candidate],
    priorAssignments: timeline.filter((v) => !v.inPeriod).map((v) => v.assignment),
    nurses: [nurse],
    shiftTypes: [...schedule.shiftTypesById.values()],
  });
  const after = costTimeline(withCandidate.timelineFor(candidate.nurseId), ctx);
  const cost = after.find((c) => c.assignmentId === candidate.id);
  if (!cost) throw new Error(`Candidate ${candidate.id} was not priced`);
  const afterTotal = after.reduce((acc, c) => acc + c.total, 0);

  return { candidate, cost, delta: afterTotal - before };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export function compareToBudget(actualDollars: number, targetDollars: number): BudgetVariance {
  return {
    targetDollars,
    actualDollars,
    variance: actualDollars - targetDollars,
    ratio: targetDollars === 0 ? null : actualDollars / targetDollars,
  };
}
