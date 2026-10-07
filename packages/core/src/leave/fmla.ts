/**
 * FMLA by the employer's regime: how many hours a nurse gets, which twelve months they are counted
 * in, how many are left and whether the nurse qualifies.
 *
 * There are two FMLAs. Title I (29 U.S.C. § 2611 ff.) covers private and state employers; Title 5
 * (5 U.S.C. § 6381 ff.; 5 C.F.R. § 630.1201 ff.) covers federal staff, VA nurses included. They
 * differ in eligibility (Title 5 has no 1,250-hour test), in entitlement (Title 5 is six times the
 * biweekly tour hours, § 630.1203(e)(2); Title I is twelve of the nurse's workweeks, and where the
 * schedule varies the weekly average of the 52 weeks before leave, 29 C.F.R. § 825.205(b)(3)) and in
 * how the twelve months are measured (a Title I employer picks one of four methods,
 * 29 C.F.R. § 825.200(b); Title 5 always starts the year on the first day of leave,
 * § 630.1203(c)). Counting every employer the Title I rolling-back way tells a VA manager the wrong
 * numbers: 480 hours is not 432, and leave is stacked across years differently.
 *
 * Everything here is advice the manager can override; the certifications and the leave itself are
 * records the database keeps.
 */

import type { FmlaPolicy, FmlaRegime } from '../domain/entities.js';
import { addDays, compareDates, type IsoDate, isIsoDate } from '../domain/time.js';

/** A twelve-month FMLA year, inclusive at both ends. */
export interface FmlaPeriod {
  from: IsoDate;
  to: IsoDate;
}

/** The same calendar day `years` away; 29 February goes to 1 March where there is none. */
function shiftYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split('-');
  const candidate = `${Number(y) + years}-${m}-${d}`;
  return (isIsoDate(candidate) ? candidate : `${Number(y) + years}-03-01`) as IsoDate;
}

/** The twelve months from `start`: through the day before the same date a year later. */
function yearFrom(start: IsoDate): FmlaPeriod {
  return { from: start, to: addDays(shiftYears(start, 1), -1) };
}

function fixedYear(startMmDd: string | undefined, onDate: IsoDate): FmlaPeriod {
  if (startMmDd === undefined || !/^\d{2}-\d{2}$/.test(startMmDd)) {
    throw new Error(`A fixed FMLA year needs a start as MM-DD, not ${startMmDd ?? 'nothing'}.`);
  }
  if (startMmDd === '02-29') {
    throw new Error('A fixed FMLA year cannot start on 02-29: most years have no such day.');
  }
  // 2001 is an arbitrary non-leap year: it only checks that MM-DD is a real day.
  if (!isIsoDate(`2001-${startMmDd}`)) {
    throw new Error(`A fixed FMLA year needs a real MM-DD start, not ${startMmDd}.`);
  }
  const year = Number(onDate.slice(0, 4));
  const thisYears = `${year}-${startMmDd}` as IsoDate;
  const from =
    compareDates(thisYears, onDate) <= 0 ? thisYears : (`${year - 1}-${startMmDd}` as IsoDate);
  return yearFrom(from);
}

/**
 * The twelve months `onDate`'s leave is counted in. `priorLeaveDates` matters only to
 * `rolling_forward`, where each year begins on a leave day and the next leave day after it ends
 * begins another. Title 5 is always rolling forward, whatever the policy says.
 */
export function fmlaPeriod(
  policy: FmlaPolicy,
  onDate: IsoDate,
  priorLeaveDates: readonly IsoDate[],
): FmlaPeriod {
  const method = policy.regime === 'title5' ? 'rolling_forward' : policy.yearMethod;
  switch (method) {
    case 'calendar': {
      const year = onDate.slice(0, 4);
      return { from: `${year}-01-01` as IsoDate, to: `${year}-12-31` as IsoDate };
    }
    case 'fixed':
      return fixedYear(policy.fixedYearStart, onDate);
    case 'rolling_backward':
      // From the day AFTER the same date a year earlier. The old `fmlaRemaining` included that
      // anniversary day and so counted 366 days of leave in a 365-day year.
      return { from: addDays(shiftYears(onDate, -1), 1), to: onDate };
    case 'rolling_forward': {
      const before = [...new Set(priorLeaveDates)]
        .filter((date) => compareDates(date, onDate) < 0)
        .sort(compareDates);
      let current: FmlaPeriod | undefined;
      for (const date of before) {
        if (current === undefined || compareDates(date, current.to) > 0) current = yearFrom(date);
      }
      if (current !== undefined && compareDates(onDate, current.to) <= 0) return current;
      return yearFrom(onDate);
    }
  }
}

export type FmlaEntitlementBasis = 'contract' | 'average' | 'title5_tour';

/** The hours of FMLA leave a nurse has in a year: twelve of their weeks. */
export function fmlaEntitlementHours(input: {
  regime: FmlaRegime;
  /** Contracted hours per 7 days. */
  contractWeeklyHours: number;
  /** Hours scheduled in the 52 weeks before leave starts; pass only when the record covers all 52. */
  scheduledHoursLast52Weeks?: number;
}): { hours: number; basis: FmlaEntitlementBasis } {
  if (input.regime === 'title5') {
    // Six times the biweekly tour hours is twelve times the weekly ones.
    return { hours: 12 * input.contractWeeklyHours, basis: 'title5_tour' };
  }
  if (input.scheduledHoursLast52Weeks !== undefined) {
    return { hours: 12 * (input.scheduledHoursLast52Weeks / 52), basis: 'average' };
  }
  return { hours: 12 * input.contractWeeklyHours, basis: 'contract' };
}

/**
 * California pregnancy disability leave: up to four months of the nurse's usual week, counted as
 * 17⅓ weeks (Cal. Code Regs. tit. 2 § 11042(a)(1)), used here rounded to 17.33: a 36-hour week
 * gives 623.88 hours where the exact 52/3 would give 624. PDL is its own entitlement under Gov. Code
 * § 12945, with no length-of-service or hours test, so FMLA's sums do not fit it: a nurse on
 * three 12s has 623.88 hours of PDL, not FMLA's 432.
 */
export function pdlEntitlementHours(input: { contractWeeklyHours: number }): number {
  return input.contractWeeklyHours * 17.33;
}

/** What is left of the entitlement in the year `onDate` falls in, counting leave later in it too. */
export function fmlaStanding(input: {
  policy: FmlaPolicy;
  entitlementHours: number;
  usedHours: readonly { date: IsoDate; hours: number }[];
  onDate: IsoDate;
}): { period: FmlaPeriod; usedHours: number; remainingHours: number } {
  const period = fmlaPeriod(
    input.policy,
    input.onDate,
    input.usedHours.map((u) => u.date),
  );
  let used = 0;
  for (const u of input.usedHours) {
    if (compareDates(u.date, period.from) >= 0 && compareDates(u.date, period.to) <= 0) {
      used += u.hours;
    }
  }
  return { period, usedHours: used, remainingHours: Math.max(0, input.entitlementHours - used) };
}

const formatHours = (n: number) => n.toLocaleString('en-US');

/**
 * Title I: 12 months employed and 1,250 hours worked in the 12 months before leave
 * (29 C.F.R. § 825.110); the employer's size test is the hospital's, not the nurse's. Title 5:
 * 12 months of service and nothing else (5 C.F.R. § 630.1202).
 */
export function fmlaEligibility(input: {
  regime: FmlaRegime;
  hiredOn: IsoDate;
  onDate: IsoDate;
  /** Required for title1 (throw if absent); ignored for title5. */
  hoursLast12Months?: number;
}): { eligible: true } | { eligible: false; reason: string } {
  if (input.regime === 'title1' && input.hoursLast12Months === undefined) {
    throw new Error('Title I FMLA eligibility needs the hours worked in the last 12 months.');
  }
  const [hy, hm, hd] = input.hiredOn.split('-').map(Number) as [number, number, number];
  const [y, m, d] = input.onDate.split('-').map(Number) as [number, number, number];
  const months = (y - hy) * 12 + (m - hm) - (d < hd ? 1 : 0);
  if (input.regime === 'title5') {
    // Federal service need not be continuous, but the app only knows the hire date, so earlier
    // service is not counted: a nurse who returned to the VA reads as ineligible until the
    // manager overrides.
    if (months < 12) {
      return {
        eligible: false,
        reason: `Employed ${months} months; FMLA needs 12 months of federal service.`,
      };
    }
    return { eligible: true };
  }
  if (months < 12) return { eligible: false, reason: `Employed ${months} months; FMLA needs 12.` };
  const hours = input.hoursLast12Months!;
  if (hours < 1250) {
    return {
      eligible: false,
      reason: `Worked ${formatHours(hours)} hours in the last 12 months; FMLA needs 1,250.`,
    };
  }
  return { eligible: true };
}
