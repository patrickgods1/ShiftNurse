/**
 * Leave balances and FMLA: whether a nurse has the paid hours a request asks for, and how much of
 * their federal job-protected leave is left.
 *
 * A request approved against a balance that cannot pay it becomes unpaid leave the nurse did not
 * agree to, or a payroll correction weeks later. And FMLA leave (29 U.S.C. § 2612; 29 C.F.R.
 * § 825.200) is 12 work weeks in a 12-month period — for a nurse on three 12s, 432 hours, not 480
 * — which a manager counting in "days" gets wrong. These are the sums; the balances themselves and
 * the certifications are records the database keeps.
 *
 * The 12-month period here is the rolling one measured back from the date (one of the four the
 * regulation allows, and the one that stops leave being stacked across a calendar year end).
 */

import { compareDates, type IsoDate, isIsoDate } from '../domain/time.js';

export interface AccrualPolicy {
  /** Hours worked for each hour of leave earned: 30 is California's sick-leave minimum. */
  hoursPerAccruedHour: number;
  /** The most the balance may hold; accrual stops there. Absent: no cap. */
  capHours?: number;
}

/** Leave earned for `hoursWorked`, never past the cap from `currentBalance`. */
export function accruedHours(
  hoursWorked: number,
  policy: AccrualPolicy,
  currentBalance = 0,
): number {
  if (!(policy.hoursPerAccruedHour > 0) || hoursWorked <= 0) return 0;
  const earned = hoursWorked / policy.hoursPerAccruedHour;
  if (policy.capHours === undefined) return earned;
  return Math.max(0, Math.min(earned, policy.capHours - currentBalance));
}

export type BalanceCheck =
  | { ok: true; remainingHours: number }
  | { ok: false; shortHours: number; message: string };

export function checkLeaveBalance(input: {
  balanceHours: number;
  requestHours: number;
}): BalanceCheck {
  const left = input.balanceHours - input.requestHours;
  if (left >= 0) return { ok: true, remainingHours: left };
  return {
    ok: false,
    shortHours: -left,
    message: `This request pays ${input.requestHours} hours; the balance is ${input.balanceHours}, ${-left} short.`,
  };
}

/** The same calendar day a year earlier; 29 February goes to 1 March. */
function yearBefore(date: IsoDate): IsoDate {
  const [y, m, d] = date.split('-');
  const candidate = `${Number(y) - 1}-${m}-${d}`;
  return (isIsoDate(candidate) ? candidate : `${Number(y) - 1}-03-01`) as IsoDate;
}

/** FMLA hours left on `onDate`: 12 of the nurse's work weeks, less leave in the year back. */
export function fmlaRemaining(input: {
  /** The nurse's usual hours a week (29 C.F.R. § 825.205(b)). */
  weeklyHours: number;
  usedHours: readonly { date: IsoDate; hours: number }[];
  onDate: IsoDate;
}): number {
  const from = yearBefore(input.onDate);
  let used = 0;
  for (const u of input.usedHours) {
    if (compareDates(u.date, from) >= 0 && compareDates(u.date, input.onDate) <= 0) used += u.hours;
  }
  return Math.max(0, 12 * input.weeklyHours - used);
}

const formatHours = (n: number) => n.toLocaleString('en-US');

/**
 * The two tests a nurse must meet (29 C.F.R. § 825.110): 12 months employed and 1,250 hours worked
 * in the 12 months before leave. The employer's size test is the hospital's, not the nurse's.
 */
export function fmlaEligibility(input: {
  hiredOn: IsoDate;
  onDate: IsoDate;
  hoursLast12Months: number;
}): { eligible: true } | { eligible: false; reason: string } {
  const [hy, hm, hd] = input.hiredOn.split('-').map(Number) as [number, number, number];
  const [y, m, d] = input.onDate.split('-').map(Number) as [number, number, number];
  const months = (y - hy) * 12 + (m - hm) - (d < hd ? 1 : 0);
  if (months < 12) return { eligible: false, reason: `Employed ${months} months; FMLA needs 12.` };
  if (input.hoursLast12Months < 1250) {
    return {
      eligible: false,
      reason: `Worked ${formatHours(input.hoursLast12Months)} hours in the last 12 months; FMLA needs 1,250.`,
    };
  }
  return { eligible: true };
}
