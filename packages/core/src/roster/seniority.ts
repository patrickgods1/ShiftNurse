/**
 * Who is senior: the one order every seniority-ranked list in the app uses.
 *
 * Bidding, holiday and request priority, the float rotation, low-census cancellation and the
 * contract overtime roster each rank by seniority, and each once broke a shared start date its
 * own way: string against numeric employee numbers, lower against higher number as the junior.
 * The same two nurses must not be senior in the bid and junior in the float; that is a grievance
 * with a written record on both sides. So there is one comparator, and a list that wants the
 * most junior first reverses it rather than writing its own.
 *
 * Employee numbers compare numerically ("E9" before "E10") through a fixed-locale collator, so
 * the order does not change with the host's ICU locale. The final id step only makes the sort
 * total for rows that share a date and a number, which is bad data, not a seniority rule.
 */

import type { Nurse } from '../domain/entities.js';
import { compareDates } from '../domain/time.js';

const EMPLOYEE_NUMBER = new Intl.Collator('en', { numeric: true });

/** Lower employee number first ("E9" before "E10"), then id; never host-locale dependent. */
export function compareEmployeeIds(
  a: Pick<Nurse, 'employeeId' | 'id'>,
  b: Pick<Nurse, 'employeeId' | 'id'>,
): number {
  return (
    EMPLOYEE_NUMBER.compare(a.employeeId, b.employeeId) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Most senior first: earliest seniority date, then the lower employee number, then id. */
export function compareSeniority(
  a: Pick<Nurse, 'seniorityDate' | 'employeeId' | 'id'>,
  b: Pick<Nurse, 'seniorityDate' | 'employeeId' | 'id'>,
): number {
  return compareDates(a.seniorityDate, b.seniorityDate) || compareEmployeeIds(a, b);
}
