/**
 * The parts of a `SolverModel` that are fixed for a whole search: the period's shifts, its work
 * weeks and overtime windows, each nurse's hours targets, the pay context and the burden each
 * nurse carries in from history.
 *
 * They are pure functions of the solve input, built once in the constructor and only read
 * afterwards. Kept here so `model.ts` holds what changes during a search — the incremental
 * state, the moves and their prices — and so each fixed piece can be read on its own. Every
 * function was moved out of the constructor without changing a computation: SA + LNS output
 * hashes on fixed inputs are identical before and after.
 */

import { type DemandTable, NURSE_ROLES } from '../acuity/demand.js';
import type { CostContext } from '../cost/types.js';
import type { Id, Nurse, ShiftType } from '../domain/entities.js';
import { dateInRange, datesInRange, dayNumber, type IsoDate, weekdayOf } from '../domain/time.js';
import { computeBurden } from '../fairness/burden.js';
import { daysAvailable } from '../fairness/exposure.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type BurdenCounters,
  EMPTY_COUNTERS,
} from '../fairness/types.js';
import {
  type ContractedHoursParams,
  type DateWindow,
  judgedPayPeriods,
  type MaxHoursParams,
  overtimeThreshold,
  payPeriodIndex,
} from '../rules/hours-rules.js';
import { leaveHoursBetween } from '../rules/paid-leave.js';
import type { RuleContext } from '../rules/types.js';
import { isElsewhere } from '../schedule/elsewhere.js';
import type { Shift } from './model.js';
import type { SolveInput } from './types.js';

/** Every date × shift type of the period, in date then sort order, with its demand row. */
export function buildShifts(
  dates: readonly IsoDate[],
  shiftTypes: readonly ShiftType[],
  demand: DemandTable,
): Shift[] {
  const shifts: Shift[] = [];
  for (const [dateIdx, date] of dates.entries()) {
    for (const shiftType of shiftTypes) {
      const row = demand.get(date, shiftType.id);
      const wanted =
        row !== undefined &&
        NURSE_ROLES.some(
          (role) => Math.max(row.byRole[role].minCount, row.byRole[role].targetCount) > 0,
        );
      shifts.push({
        idx: shifts.length,
        date,
        dateIdx,
        shiftType,
        demand: row,
        solvable: shiftType.active && wanted,
      });
    }
  }
  return shifts;
}

/** Which work week, and which overtime window (a week, or an 8/80 pay period), a date is in. */
export interface WorkCalendar {
  weekOf: (date: IsoDate) => number;
  weekOfDate: number[];
  weekCount: number;
  overtimeOf: (date: IsoDate) => number;
  overtimeOfDate: number[];
  overtimeCount: number;
  overtimeThreshold: number;
}

export function workCalendar(
  input: SolveInput,
  dates: readonly IsoDate[],
  maxHours: MaxHoursParams,
): WorkCalendar {
  const firstDay = dayNumber(input.period.startDate);
  const weekStart =
    firstDay - ((weekdayOf(input.period.startDate) - maxHours.workWeekStartsOn + 7) % 7);
  const weekOf = (date: IsoDate) => Math.floor((dayNumber(date) - weekStart) / 7);
  const weekOfDate = dates.map((date) => weekOf(date));
  const weekCount = (weekOfDate[weekOfDate.length - 1] ?? 0) + 1;
  const firstPayPeriod = payPeriodIndex(input.period.startDate, input.unit);
  const overtimeOf = maxHours.overtimeByPayPeriod
    ? (date: IsoDate) => payPeriodIndex(date, input.unit) - firstPayPeriod
    : weekOf;
  const overtimeOfDate = dates.map((date) => overtimeOf(date));
  const overtimeCount = (overtimeOfDate[overtimeOfDate.length - 1] ?? 0) + 1;
  return {
    weekOf,
    weekOfDate,
    weekCount,
    overtimeOf,
    overtimeOfDate,
    overtimeCount,
    overtimeThreshold: overtimeThreshold(maxHours),
  };
}

/** Pricing a shift's pay needs the same overtime week the max-hours rule judges by. */
export function costContextFor(
  input: SolveInput,
  ctx: RuleContext,
  maxHours: MaxHoursParams,
): CostContext | undefined {
  return input.cost
    ? {
        unit: input.unit,
        payRates: input.cost.payRates,
        differentials: input.cost.differentials.filter((d) => d.active),
        overtimeRules: input.cost.overtimeRules.filter((r) => r.active),
        holidayDates: ctx.holidayDates,
        majorHolidayDates: ctx.majorHolidayDates,
        weekendDefinition: input.ruleSet.weekendDefinition,
        workWeekStartsOn: maxHours.workWeekStartsOn,
        ...(maxHours.paidLeaveCountsTowardOvertime ? { overtimeLeave: ctx.paidLeaveByNurse } : {}),
      }
    : undefined;
}

/**
 * The pay periods the FTE rule judges (`judgedPayPeriods`), plus any remainder, and what each
 * nurse owes. A pay period the schedule opens in is judged with the published hours before it, so
 * its bucket owes, and may take, only what those hours left: optimising toward the whole contract
 * there would chase hours the grid then flags as past it.
 */
export interface HoursBuckets {
  bucketOfDate: number[];
  bucketCount: number;
  /** What the objective chases per bucket: the contract still unscheduled, leave taken off. */
  hoursTarget: number[][];
  /**
   * The most straight time a bucket may hold before the rule calls it over the contract (the
   * prefilter's cap). Published hours marked authorised overtime are left out, as the rule does.
   */
  hoursCap: number[][];
  hoursCapped: boolean[];
  contractedProRata: number[];
}

export function hoursBuckets(
  input: SolveInput,
  dates: readonly IsoDate[],
  dateIdx: ReadonlyMap<IsoDate, number>,
  nurses: readonly Nurse[],
  fteParams: ContractedHoursParams,
  ctx: RuleContext,
): HoursBuckets {
  const periods = judgedPayPeriods(
    { start: input.period.startDate, end: input.period.endDate },
    input.unit,
    fteParams.onlyCompletePayPeriods,
    input.historyFrom,
  );
  const bucketOfDate = dates.map((date) => {
    const i = periods.findIndex((p) => dateInRange(date, p.start, p.end));
    return i === -1 ? periods.length : i;
  });
  const bucketDays = new Array<number>(periods.length + 1).fill(0);
  for (const b of bucketOfDate) bucketDays[b] = (bucketDays[b] ?? 0) + 1;
  const bucketCount = bucketDays[periods.length] === 0 ? periods.length : periods.length + 1;

  // Paid leave counts toward the contract, so it comes off the hours still to schedule:
  // "worked + leave within tolerance of target" is "worked within tolerance of target − leave".
  const leaveOnDatesOf = (nurseId: Id, b: number) => {
    if (!fteParams.paidLeaveCountsTowardHours) return 0;
    let hours = 0;
    for (const c of ctx.paidLeaveByNurse.get(nurseId) ?? []) {
      const idx = dateIdx.get(c.date);
      if (idx !== undefined && bucketOfDate[idx] === b) hours += c.hours;
    }
    return hours;
  };
  // The rule judges a pay period on all of it, the days before the schedule included.
  const leaveInPayPeriod = (nurseId: Id, b: number) =>
    fteParams.paidLeaveCountsTowardHours
      ? leaveHoursBetween(ctx.paidLeaveByNurse.get(nurseId), periods[b]!.start, periods[b]!.end)
      : 0;
  const { prior, priorOvertime } = priorHoursByPayPeriod(input, nurses, periods, fteParams);

  const hoursTarget: number[][] = [];
  const hoursCap: number[][] = [];
  for (const [n, nurse] of nurses.entries()) {
    const contract = nurse.contractedHoursPerPeriod;
    const share = (days: number) => (contract * days) / input.unit.payPeriodDays;
    const targets: number[] = [];
    const caps: number[] = [];
    for (let b = 0; b < bucketCount; b++) {
      const period = periods[b];
      if (contract <= 0) {
        targets.push(0);
        caps.push(fteParams.overToleranceHours);
      } else if (period === undefined) {
        // The remainder: days in no judged pay period, owed their share of the contract.
        const target = share(bucketDays[b] ?? 0) - leaveOnDatesOf(nurse.id, b);
        targets.push(target);
        caps.push(target + fteParams.overToleranceHours);
      } else {
        const whole =
          share(input.unit.payPeriodDays) - leaveInPayPeriod(nurse.id, b) - prior[n]![b]!;
        // Not judged short (its start is not on record): chase the schedule's share as the
        // remainder does, but never let it pass the contract the rule still holds it to.
        targets.push(
          period.underJudged ? whole : share(bucketDays[b] ?? 0) - leaveOnDatesOf(nurse.id, b),
        );
        caps.push(whole + priorOvertime[n]![b]! + fteParams.overToleranceHours);
      }
    }
    hoursTarget.push(targets);
    hoursCap.push(caps);
  }
  const hoursCapped = nurses.map(
    (nurse) =>
      nurse.contractedHoursPerPeriod > 0 &&
      !fteParams.exemptEmploymentTypes.includes(nurse.employmentType),
  );
  const contractedProRata = nurses.map((nurse) =>
    nurse.contractedHoursPerPeriod > 0
      ? (nurse.contractedHoursPerPeriod * dates.length) / input.unit.payPeriodDays
      : 0,
  );
  return { bucketOfDate, bucketCount, hoursTarget, hoursCap, hoursCapped, contractedProRata };
}

/**
 * Each nurse's published hours in each judged pay period, counted as the rule counts them:
 * scheduled (a holdover was not scheduled past the contract), standby only when the rule says,
 * another unit's shifts never — and, apart, the part of them marked authorised overtime, which
 * counts toward the contract but not against its ceiling. Zero throughout without `historyFrom`,
 * as the rule then reads only this schedule's shifts.
 */
function priorHoursByPayPeriod(
  input: SolveInput,
  nurses: readonly Nurse[],
  periods: readonly DateWindow[],
  fteParams: ContractedHoursParams,
): { prior: number[][]; priorOvertime: number[][] } {
  const out = nurses.map(() => new Array<number>(periods.length).fill(0));
  const overtime = nurses.map(() => new Array<number>(periods.length).fill(0));
  if (input.historyFrom === undefined || periods.length === 0) {
    return { prior: out, priorOvertime: overtime };
  }
  const nurseIdx = new Map(nurses.map((nurse, i) => [nurse.id, i]));
  const typeById = new Map(input.shiftTypes.map((t) => [t.id, t]));
  for (const a of input.priorAssignments) {
    const n = nurseIdx.get(a.nurseId);
    if (n === undefined)
      throw new Error(`Prior assignment ${a.id} references unknown nurse ${a.nurseId}`);
    const type = typeById.get(a.shiftTypeId);
    if (!type) throw new Error(`Prior assignment ${a.id} has unknown shift type ${a.shiftTypeId}`);
    if (isElsewhere(type)) continue;
    if (type.isOnCall && !fteParams.onCallCountsTowardHours) continue;
    const b = periods.findIndex((p) => dateInRange(a.date, p.start, p.end));
    if (b === -1) continue;
    out[n]![b]! += type.durationHours;
    if (a.isOvertime) overtime[n]![b]! += type.durationHours;
  }
  return { prior: out, priorOvertime: overtime };
}

/**
 * Historical burden, weighted exactly as computeBurden weights it under a current row, and each
 * nurse's fair weight. The current row carries no work but the period's length and the days the
 * nurse is available in it: exposure reads leave and the hire date, never the assignment, which
 * is what lets the model hold the fair weights fixed for the whole search.
 */
export function historyFairness(
  nurses: readonly Nurse[],
  activeNurses: readonly Nurse[],
  input: SolveInput,
): { histCarried: Record<BurdenComponent, number>[]; fairWeight: number[] } {
  const { startDate, endDate } = input.period;
  const periodDays = datesInRange(startDate, endDate).length;
  const zero = new Map<Id, BurdenCounters>(
    activeNurses.map((x) => [
      x.id,
      {
        ...EMPTY_COUNTERS,
        periodDays,
        availableDays: daysAvailable(x, startDate, endDate, input.timeOff),
      },
    ]),
  );
  const burden = computeBurden(
    activeNurses,
    input.ledgerHistory,
    { asOf: startDate, periodDays, payPeriodDays: input.unit.payPeriodDays },
    { weights: input.ruleSet.fairnessWeights },
    zero,
  );
  const histCarried = nurses.map((nurse) => {
    const row = burden.byNurse.get(nurse.id);
    const out = {} as Record<BurdenComponent, number>;
    for (const c of BURDEN_COMPONENTS) out[c] = row ? row.carried[BURDEN_COUNTER[c]] : 0;
    return out;
  });
  const fairWeight = nurses.map((nurse) => burden.byNurse.get(nurse.id)?.fairWeight ?? 0);
  return { histCarried, fairWeight };
}
