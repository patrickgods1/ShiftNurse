/**
 * Projecting a leave balance from the last payroll figure to the day a request starts.
 *
 * Payroll gives a balance as of a date; the app does not run payroll, so a manager approving
 * leave three pay periods later is checking against a stale number. Accrual that has closed since
 * and leave already approved move it, and carryover ceilings (federal annual leave 240 h under
 * 5 U.S.C. § 6304(a); VA Title 38 full-time nurses 685 h) forfeit hours at each leave-year
 * turnover. A projection that ignored the forfeiture would promise hours the nurse no longer has.
 *
 * Events fall strictly between `asOf` and `onDate`: payroll's figure already includes `asOf`, and
 * the request starting on `onDate` is checked against the result, not part of it. On one date the
 * order is forfeit, accrue, use: the carryover cap applies to what was carried in, not to what
 * the period closing that day earns, and leave is drawn from what is then held.
 *
 * A front-loaded rule (Lab. Code § 246(d)) earns nothing per pay period: each leave-year start
 * sets the balance to the year's amount, and what was held before is not kept.
 *
 * `usedThisYearHours` is what a yearly use cap (California sick leave: 40 hours) is measured
 * against. It counts leave used since the leave year began, before payroll's date included: the
 * cap is on use, and payroll's balance says nothing about when its hours were drawn.
 *
 * The result is information, not a verdict: a balance may go negative, and the manager decides.
 */

import type {
  AccrualRule,
  AccrualTier,
  LeaveBalanceType,
  LeavePolicy,
  LeaveYearStart,
  Nurse,
} from '../domain/entities.js';
import { compareDates, dayNumber, type IsoDate, isoDate } from '../domain/time.js';
import { type PayCalendar, payPeriodIndex, payPeriodWindow } from '../rules/hours-rules.js';

/** Whole years from serviceStart to onDate (an anniversary counts on the day). */
export function yearsOfService(serviceStart: IsoDate, onDate: IsoDate): number {
  // Month-day strings compare in calendar order; a 29 February start reaches its anniversary on
  // 1 March in a common year.
  const years = Number(onDate.slice(0, 4)) - Number(serviceStart.slice(0, 4));
  const anniversaryPending = onDate.slice(5) < serviceStart.slice(5);
  return Math.max(0, anniversaryPending ? years - 1 : years);
}

/** The first rule matching balance type, role and employment type (absent lists match all), or undefined. */
export function accrualRuleFor(
  policy: LeavePolicy,
  nurse: Pick<Nurse, 'role' | 'employmentType'>,
  balanceType: LeaveBalanceType,
): AccrualRule | undefined {
  return policy.accrual.find(
    (r) =>
      r.balanceType === balanceType &&
      (r.roles === undefined || r.roles.includes(nurse.role)) &&
      (r.employmentTypes === undefined || r.employmentTypes.includes(nurse.employmentType)),
  );
}

/** Leave-year start dates d with from < d <= to. */
export function leaveYearStarts(
  start: LeaveYearStart,
  calendar: PayCalendar,
  from: IsoDate,
  to: IsoDate,
): IsoDate[] {
  const out: IsoDate[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const january = isoDate(`${String(year).padStart(4, '0')}-01-01`);
    let date = january;
    if (start === 'first_full_pay_period') {
      // 5 U.S.C. § 6302(a): the first pay period that begins on or after 1 January.
      let index = payPeriodIndex(january, calendar);
      if (compareDates(payPeriodWindow(index, calendar).start, january) < 0) index++;
      date = payPeriodWindow(index, calendar).start;
    }
    if (compareDates(date, from) > 0 && compareDates(date, to) <= 0) out.push(date);
  }
  return out;
}

export interface BalanceProjection {
  hours: number;
  accruedHours: number;
  usedHours: number;
  forfeitedHours: number;
  /** Leave used from the start of the leave year `onDate` falls in up to the day before it. */
  usedThisYearHours: number;
}

function tierAt(tiers: readonly AccrualTier[], years: number): AccrualTier | undefined {
  let found: AccrualTier | undefined;
  for (const t of tiers) if (t.fromYearsOfService <= years) found = t;
  return found;
}

type Event =
  | { date: IsoDate; order: 0 }
  | { date: IsoDate; order: 1; periodStart: IsoDate }
  | { date: IsoDate; order: 2; hours: number };

export function projectBalance(input: {
  balanceHours: number;
  asOf: IsoDate;
  onDate: IsoDate;
  rule?: AccrualRule;
  serviceStart: IsoDate;
  calendar: PayCalendar;
  leaveYearStart: LeaveYearStart;
  /** Hours worked or in pay status per pay period, keyed by the period's first day. Read only by per-hour tiers; a missing period counts 0. */
  hoursByPayPeriodStart?: ReadonlyMap<IsoDate, number>;
  /** Approved paid leave drawn on this balance. */
  used: readonly { date: IsoDate; hours: number }[];
}): BalanceProjection {
  const { asOf, onDate, rule } = input;
  const inside = (date: IsoDate) => compareDates(date, asOf) > 0 && compareDates(date, onDate) < 0;

  const events: Event[] = [];
  for (const date of leaveYearStarts(input.leaveYearStart, input.calendar, asOf, onDate)) {
    if (inside(date)) events.push({ date, order: 0 });
  }
  if (rule && rule.frontLoadHours === undefined) {
    let index = payPeriodIndex(asOf, input.calendar);
    for (;;) {
      const window = payPeriodWindow(index++, input.calendar);
      if (compareDates(window.end, onDate) >= 0) break;
      if (inside(window.end)) {
        events.push({ date: window.end, order: 1, periodStart: window.start });
      }
    }
  }
  for (const u of input.used) {
    if (inside(u.date)) events.push({ date: u.date, order: 2, hours: u.hours });
  }
  events.sort((a, b) => dayNumber(a.date) - dayNumber(b.date) || a.order - b.order);

  let hours = input.balanceHours;
  let accrued = 0;
  let used = 0;
  let forfeited = 0;
  for (const e of events) {
    if (e.order === 0) {
      const cap = rule?.carryoverCapHours;
      if (cap !== undefined && hours > cap) {
        forfeited += hours - cap;
        hours = cap;
      }
      if (rule?.frontLoadHours !== undefined) {
        // The carryover cap above limits what is carried, not the new year's amount: a
        // front-loaded balance replaces what was held, and § 246(d) needs none of it carried.
        // A negative balance is not forgiven as a forfeit, only replaced.
        forfeited += Math.max(0, hours);
        hours = rule.frontLoadHours;
        accrued += rule.frontLoadHours;
      }
    } else if (e.order === 1 && rule) {
      const tier = tierAt(rule.tiers, yearsOfService(input.serviceStart, e.date));
      let earned = 0;
      if (tier?.hoursPerPayPeriod !== undefined) earned = tier.hoursPerPayPeriod;
      else if (tier?.hoursPerAccruedHour !== undefined && tier.hoursPerAccruedHour > 0) {
        earned = (input.hoursByPayPeriodStart?.get(e.periodStart) ?? 0) / tier.hoursPerAccruedHour;
      }
      if (rule.balanceCapHours !== undefined) {
        earned = Math.max(0, Math.min(earned, rule.balanceCapHours - hours));
      }
      hours += earned;
      accrued += earned;
    } else if (e.order === 2) {
      hours -= e.hours;
      used += e.hours;
    }
  }
  return {
    hours,
    accruedHours: accrued,
    usedHours: used,
    forfeitedHours: forfeited,
    usedThisYearHours: usedThisYear(input.used, input.leaveYearStart, input.calendar, onDate),
  };
}

/** Leave in `used` dated from the leave year's start on or before `onDate` up to the day before it. */
function usedThisYear(
  used: readonly { date: IsoDate; hours: number }[],
  start: LeaveYearStart,
  calendar: PayCalendar,
  onDate: IsoDate,
): number {
  // From the last day of the year before last: a federal year that starts in mid-January leaves
  // early-January dates in the previous year's leave year, whose start is then the latest found.
  const from = isoDate(`${String(Number(onDate.slice(0, 4)) - 2).padStart(4, '0')}-12-31`);
  const yearStart = leaveYearStarts(start, calendar, from, onDate).at(-1);
  let total = 0;
  for (const u of used) {
    if (yearStart !== undefined && compareDates(u.date, yearStart) < 0) continue;
    if (compareDates(u.date, onDate) < 0) total += u.hours;
  }
  return total;
}
