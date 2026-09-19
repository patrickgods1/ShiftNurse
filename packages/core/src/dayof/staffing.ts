/**
 * The Today screen's live ratio re-check.
 *
 * A forecast is a guess made days ago; by 06:50 the charge nurse knows the *actual* census,
 * and the question that matters is whether the shift about to start is still ratio-compliant
 * against that number, not the one the solver planned against. `withActualCensus` is the only
 * place an actual replaces a projection — everything downstream runs through `deriveDemand`
 * exactly as the Demand page and the solver do, so this check can never disagree with them
 * about what a given census requires. `checkStaffing` just decides *which* census number to
 * hand it and re-derives from there.
 *
 * `shiftsAround` answers "what's running right now" on the same continuous wall-clock timeline
 * as everywhere else in core (see `domain/time.ts`): a night shift is dated by the day it
 * *started*, so a night shift running at 03:00 is yesterday's slot, not today's — exactly the
 * distinction that matters when the charge nurse looks at the console mid-shift.
 */

import { type DemandInputs, deriveDemand, NURSE_ROLES } from '../acuity/demand.js';
import type {
  Assignment,
  CensusForecast,
  Nurse,
  NurseRole,
  ShiftType,
} from '../domain/entities.js';
import { addDays, dayNumber, type IsoDate, MINUTES_PER_DAY, shiftWindow } from '../domain/time.js';
import type {
  CensusBasis,
  RoleStaffing,
  ShiftSlot,
  ShiftStaffingCheck,
  ShiftsAround,
} from './types.js';

export interface StaffingCheckInput {
  date: IsoDate;
  shiftTypes: readonly ShiftType[];
  nurses: readonly Nurse[];
  /** Every assignment dated `date` (any period). */
  assignments: readonly Assignment[];
  /** The unit's demand inputs; `censusForecasts` need only cover `date`. */
  demand: DemandInputs;
}

/**
 * Swap in the actual census wherever the manager has entered one. This is the sole seam
 * between "what we predicted" and "what's on the floor" — every other function in this module
 * (and in the rest of core) sees only `projectedCensus`/`acuityMix`, so there is exactly one
 * place that can get the substitution wrong.
 */
export function withActualCensus(forecasts: readonly CensusForecast[]): CensusForecast[] {
  return forecasts.map((f) =>
    f.actualCensus !== undefined && f.actualAcuityMix !== undefined
      ? { ...f, projectedCensus: f.actualCensus, acuityMix: f.actualAcuityMix }
      : f,
  );
}

/** For one date, per active shift type, how many nurses of each role are required vs. rostered. */
export function checkStaffing(input: StaffingCheckInput): ShiftStaffingCheck[] {
  const { date, shiftTypes, nurses, assignments, demand } = input;

  // Which (date, shift) slots had a manager-entered actual, judged on the *original* forecast —
  // `withActualCensus` only rewrites the numbers `deriveDemand` sees, not this bookkeeping.
  const hasActualByShiftType = new Set<string>();
  for (const f of demand.censusForecasts) {
    if (f.date === date && f.actualCensus !== undefined && f.actualAcuityMix !== undefined) {
      hasActualByShiftType.add(f.shiftTypeId);
    }
  }

  const table = deriveDemand([date], {
    ...demand,
    censusForecasts: withActualCensus(demand.censusForecasts),
  });

  const nurseById = new Map(nurses.map((n) => [n.id, n]));

  const active = [...shiftTypes].filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);

  const checks: ShiftStaffingCheck[] = [];
  for (const shiftType of active) {
    const row = table.get(date, shiftType.id);
    // deriveDemand emits a row for every active shift type it was given; if the caller's
    // `shiftTypes` and `demand.shiftTypes` disagree, skip rather than invent a row.
    if (!row) continue;

    const basis: CensusBasis = row.fromCoverageFloorOnly
      ? 'floor'
      : hasActualByShiftType.has(shiftType.id)
        ? 'actual'
        : 'forecast';

    const staffedByRole: Record<NurseRole, number> = { RN: 0, LPN: 0, CNA: 0 };
    for (const a of assignments) {
      if (a.date !== date || a.shiftTypeId !== shiftType.id) continue;
      const nurse = nurseById.get(a.nurseId);
      // Bad data is loud: a phantom assignment must not silently pass or fail the count.
      if (!nurse) throw new Error(`Unknown nurse ${a.nurseId}`);
      staffedByRole[nurse.role]++;
    }

    const byRole = {} as Record<NurseRole, RoleStaffing>;
    for (const role of NURSE_ROLES) {
      const roleDemand = row.byRole[role];
      const required = roleDemand?.minCount ?? 0;
      const staffed = staffedByRole[role];
      byRole[role] = {
        role,
        required,
        staffed,
        shortfall: Math.max(0, required - staffed),
        bindingConstraint: roleDemand?.bindingConstraint ?? 'coverage_floor',
      };
    }

    const short = NURSE_ROLES.some((role) => byRole[role].shortfall > 0);
    const ratioBreached = NURSE_ROLES.some(
      (role) =>
        byRole[role].shortfall > 0 &&
        (byRole[role].bindingConstraint === 'ratio' || byRole[role].bindingConstraint === 'both'),
    );

    checks.push({
      date,
      shiftTypeId: shiftType.id,
      basis,
      census: row.projectedCensus,
      byRole,
      short,
      ratioBreached,
    });
  }

  return checks;
}

/** Which shift slots are running at `minuteOfDay` on `date`, and which slot starts next. */
export function shiftsAround(
  shiftTypes: readonly ShiftType[],
  date: IsoDate,
  minuteOfDay: number,
): ShiftsAround {
  const active = shiftTypes.filter((t) => t.active);
  const sortOrderById = new Map(active.map((t) => [t.id, t.sortOrder]));
  const yesterday = addDays(date, -1);
  const tomorrow = addDays(date, 1);
  const queryMinute = dayNumber(date) * MINUTES_PER_DAY + minuteOfDay;

  const current: ShiftSlot[] = [];
  for (const type of active) {
    const todayWindow = shiftWindow(date, type);
    if (queryMinute >= todayWindow.startMinute && queryMinute < todayWindow.endMinute) {
      current.push({ date, shiftTypeId: type.id });
    }
    // A shift that started yesterday and crosses midnight is still running now — it is
    // "yesterday's slot" per the dating convention in `domain/time.ts`.
    const yesterdayWindow = shiftWindow(yesterday, type);
    if (queryMinute >= yesterdayWindow.startMinute && queryMinute < yesterdayWindow.endMinute) {
      current.push({ date: yesterday, shiftTypeId: type.id });
    }
  }
  current.sort((a, b) => {
    const byDate = dayNumber(a.date) - dayNumber(b.date);
    if (byDate !== 0) return byDate;
    return sortOrderById.get(a.shiftTypeId)! - sortOrderById.get(b.shiftTypeId)!;
  });

  const todaysUpcoming = active
    .map((type) => ({ type, startMinute: shiftWindow(date, type).startMinute }))
    .filter(({ startMinute }) => startMinute > queryMinute)
    .sort((a, b) => a.startMinute - b.startMinute || a.type.sortOrder - b.type.sortOrder);

  let next: ShiftSlot | undefined;
  if (todaysUpcoming.length > 0) {
    next = { date, shiftTypeId: todaysUpcoming[0]!.type.id };
  } else {
    const tomorrowsFirst = active
      .map((type) => ({ type, startMinute: shiftWindow(tomorrow, type).startMinute }))
      .sort((a, b) => a.startMinute - b.startMinute || a.type.sortOrder - b.type.sortOrder)[0];
    next = tomorrowsFirst ? { date: tomorrow, shiftTypeId: tomorrowsFirst.type.id } : undefined;
  }

  return { current, next };
}
