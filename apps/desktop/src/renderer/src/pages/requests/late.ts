/**
 * Whether a time-off request came in after the period's request window closed. The closing date
 * is a calendar day on the ward; a request made any time that day, on this machine's clock, is
 * on time. Display only: a late request is decided first-come with a cover plan, never refused.
 */

import type { IsoDate } from '@shiftnurse/core';

export function isLateRequest(submittedAt: number, closesOn: IsoDate | undefined): boolean {
  if (closesOn === undefined || submittedAt <= 0) return false;
  const [y, m, d] = closesOn.split('-').map(Number);
  const endOfDay = new Date(y!, m! - 1, d! + 1).getTime();
  return submittedAt >= endOfDay;
}
