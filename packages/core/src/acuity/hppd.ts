/**
 * Scheduled nursing hours per patient day: what a schedule actually spends against the unit's
 * HPPD budget.
 *
 * The HPPD target on its own answers "how many nurses does the budget pay for on this shift";
 * nothing answered "is this schedule over budget". A manager reconciling staffing spend thinks
 * in HPPD, so the figure is reported per day and for the whole range, never used by Generate.
 *
 * Hours are each shift's paid length, the same number cost and the contract rules use; standby
 * is not nursing care and is left out. Patient days are the day's census averaged over the
 * standalone shifts that have a forecast, weighted by their length: a 24-patient day 12 and a
 * 16-patient night 12 are a 20-patient day. A shift inside another adds its hours but no census
 * of its own — its patients are already counted by the shift it runs inside — and a day with no
 * forecast at all is left out of both sums and listed, rather than read as zero patients.
 */

import type { Assignment, HppdTarget, ShiftType } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import type { DemandTable } from './demand.js';

export interface HppdDay {
  date: IsoDate;
  nursingHours: number;
  patientDays: number;
  /** Undefined when the day has no census forecast. */
  hppd: number | undefined;
}

export interface HppdReport {
  targetHours: number | undefined;
  /** Over the measured days only. */
  nursingHours: number;
  patientDays: number;
  hppd: number | undefined;
  days: HppdDay[];
  /** Days with no census forecast, left out of the totals. */
  unmeasuredDates: IsoDate[];
}

export interface HppdInput {
  dates: readonly IsoDate[];
  shiftTypes: readonly ShiftType[];
  demand: DemandTable;
  assignments: readonly Pick<Assignment, 'date' | 'shiftTypeId'>[];
  target?: HppdTarget;
}

export function scheduledHppd(input: HppdInput): HppdReport {
  const byId = new Map(input.shiftTypes.map((s) => [s.id, s]));
  const censusShifts = input.shiftTypes.filter(
    (s) => s.withinShiftTypeId === null && !s.isOnCall && s.durationHours > 0,
  );

  const hoursByDate = new Map<IsoDate, number>();
  for (const a of input.assignments) {
    const shiftType = byId.get(a.shiftTypeId);
    if (shiftType === undefined) throw new Error(`Unknown shift type ${a.shiftTypeId}`);
    if (shiftType.isOnCall) continue;
    hoursByDate.set(a.date, (hoursByDate.get(a.date) ?? 0) + shiftType.durationHours);
  }

  const days: HppdDay[] = [];
  const unmeasuredDates: IsoDate[] = [];
  let nursingHours = 0;
  let patientDays = 0;
  for (const date of input.dates) {
    let censusHours = 0;
    let forecastHours = 0;
    for (const shiftType of censusShifts) {
      const demand = input.demand.get(date, shiftType.id);
      if (demand === undefined || demand.fromCoverageFloorOnly) continue;
      censusHours += demand.projectedCensus * shiftType.durationHours;
      forecastHours += shiftType.durationHours;
    }
    const hours = hoursByDate.get(date) ?? 0;
    if (forecastHours === 0) {
      unmeasuredDates.push(date);
      days.push({ date, nursingHours: hours, patientDays: 0, hppd: undefined });
      continue;
    }
    const dayPatients = censusHours / forecastHours;
    nursingHours += hours;
    patientDays += dayPatients;
    days.push({
      date,
      nursingHours: hours,
      patientDays: dayPatients,
      hppd: dayPatients > 0 ? hours / dayPatients : undefined,
    });
  }

  return {
    targetHours: input.target?.targetHours,
    nursingHours,
    patientDays,
    hppd: patientDays > 0 ? nursingHours / patientDays : undefined,
    days,
    unmeasuredDates,
  };
}
