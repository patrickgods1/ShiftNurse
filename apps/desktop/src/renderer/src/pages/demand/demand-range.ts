/**
 * Whether a Staffing needs date range is one the page can show. Every day in the range is a row
 * of census editors in the grid plus a demand computation in main, and a half-typed year
 * ("0202-10-16") once made that 666,261 days — a frozen window. The length comes from
 * `daysBetween` (arithmetic), never from building the date list, so even a runaway range is
 * refused cheaply.
 */

import { daysBetween, type IsoDate } from '@shiftnurse/core';

/** Below the 400-day cap main puts on the same IPC calls. */
export const MAX_RANGE_DAYS = 120;

/** Why this range cannot be shown, or undefined. Both ends inclusive. */
export function rangeProblem(start: IsoDate, end: IsoDate): string | undefined {
  const span = daysBetween(start, end);
  if (span < 0) return 'The end date is before the start date.';
  const days = span + 1;
  if (days > MAX_RANGE_DAYS) {
    return `Show at most ${MAX_RANGE_DAYS} days at a time; this range is ${days} days.`;
  }
  return undefined;
}
