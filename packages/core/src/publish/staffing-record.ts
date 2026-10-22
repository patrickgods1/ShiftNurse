/**
 * The staffing record: required against actual staff, day by day and shift by shift.
 *
 * 22 CCR § 70217(c) makes a California hospital document "the actual staff and staff mix
 * provided, documented on a day-to-day, shift-by-shift basis" and "the variance between required
 * and actual staffing patterns". `checkStaffing` already computes both for the Today screen but
 * only for the moment; without this projection that comparison is gone by tomorrow, and the
 * answer to an inspector is reconstructed from a schedule that has since been edited.
 *
 * The caller decides who counts: `checkStaffing` counts every assignment it is given (floated-off
 * rows aside), so the caller must filter out a shift whose call-off is open or uncovered before
 * checking — that nurse did not work it. Only standalone floor shifts are listed: standby is not
 * staff on the floor, and a shift running inside another is judged within its container's row.
 * RN, LPN and CNA are always listed, zeros included, because the staff mix is part of the record.
 */

import { NURSE_ROLES } from '../acuity/demand.js';
import type { CensusBasis, ShiftStaffingCheck } from '../dayof/types.js';
import type { NurseRole, ShiftType } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';

export interface StaffingRecordDay {
  date: IsoDate;
  shiftTypes: readonly ShiftType[];
  /** `checkStaffing`'s output for `date`, built on the assignments that were worked. */
  checks: readonly ShiftStaffingCheck[];
}

/** `'licensed'` is the pooled RN + LPN ratio line. */
export type StaffingRecordRole = NurseRole | 'licensed';

export interface StaffingRecordRow {
  date: IsoDate;
  shiftTypeId: string;
  shiftTypeName: string;
  role: StaffingRecordRole;
  required: number;
  actual: number;
  /** Actual minus required: negative is short. */
  variance: number;
  basis: CensusBasis;
  census: number;
}

export function buildStaffingRecord(days: readonly StaffingRecordDay[]): StaffingRecordRow[] {
  const rows: StaffingRecordRow[] = [];
  for (const day of days) {
    const typeById = new Map(day.shiftTypes.map((t) => [t.id, t]));
    for (const check of day.checks) {
      const type = typeById.get(check.shiftTypeId);
      // Bad data is loud: a check we cannot name would be a row nobody can read.
      if (!type) {
        throw new Error(
          `${day.date}: staffing was checked for a shift type that is not on that day`,
        );
      }
      if (type.isOnCall || type.withinShiftTypeId != null) continue;
      const row = (role: StaffingRecordRole, required: number, actual: number) =>
        rows.push({
          date: day.date,
          shiftTypeId: type.id,
          shiftTypeName: type.name,
          role,
          required,
          actual,
          variance: actual - required,
          basis: check.basis,
          census: check.census,
        });
      for (const role of NURSE_ROLES) {
        const staffing = check.byRole[role];
        row(role, staffing.required, staffing.staffed);
      }
      if (check.licensed) row('licensed', check.licensed.required, check.licensed.staffed);
    }
  }
  return rows;
}
