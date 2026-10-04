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
import { dateInRange, dayNumber, type IsoDate, weekdayOf } from '../domain/time.js';
import { computeBurden } from '../fairness/burden.js';
import {
  BURDEN_COMPONENTS,
  BURDEN_COUNTER,
  type BurdenComponent,
  type BurdenCounters,
  EMPTY_COUNTERS,
} from '../fairness/types.js';
import {
  type ContractedHoursParams,
  type MaxHoursParams,
  overtimeThreshold,
  payPeriodIndex,
  payPeriodsIn,
} from '../rules/hours-rules.js';
import type { RuleContext } from '../rules/types.js';
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

/** The complete pay periods the FTE rule judges, plus any remainder, and what each nurse owes. */
export interface HoursBuckets {
  bucketOfDate: number[];
  bucketCount: number;
  hoursTarget: number[][];
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
  const periods = payPeriodsIn(
    { start: input.period.startDate, end: input.period.endDate },
    input.unit,
    true,
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
  const leaveInBucket = (nurseId: Id, b: number) => {
    if (!fteParams.paidLeaveCountsTowardHours) return 0;
    let hours = 0;
    for (const c of ctx.paidLeaveByNurse.get(nurseId) ?? []) {
      const idx = dateIdx.get(c.date);
      if (idx !== undefined && bucketOfDate[idx] === b) hours += c.hours;
    }
    return hours;
  };
  const hoursTarget = nurses.map((nurse) =>
    Array.from({ length: bucketCount }, (_, b) =>
      nurse.contractedHoursPerPeriod > 0
        ? (nurse.contractedHoursPerPeriod * (bucketDays[b] ?? 0)) / input.unit.payPeriodDays -
          leaveInBucket(nurse.id, b)
        : 0,
    ),
  );
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
  return { bucketOfDate, bucketCount, hoursTarget, hoursCapped, contractedProRata };
}

/** Historical burden, weighted exactly as computeBurden weights it under a current row. */
export function historyFairness(
  nurses: readonly Nurse[],
  activeNurses: readonly Nurse[],
  input: SolveInput,
): { histCarried: Record<BurdenComponent, number>[]; shareWeight: number[] } {
  const zero = new Map<Id, BurdenCounters>(activeNurses.map((x) => [x.id, EMPTY_COUNTERS]));
  const burden = computeBurden(
    activeNurses,
    input.ledgerHistory,
    { weights: input.ruleSet.fairnessWeights },
    zero,
  );
  const histCarried = nurses.map((nurse) => {
    const row = burden.byNurse.get(nurse.id);
    const out = {} as Record<BurdenComponent, number>;
    for (const c of BURDEN_COMPONENTS) out[c] = row ? row.carried[BURDEN_COUNTER[c]] : 0;
    return out;
  });
  const shareWeight = nurses.map((nurse) => burden.byNurse.get(nurse.id)?.shareWeight ?? 0);
  return { histCarried, shareWeight };
}
