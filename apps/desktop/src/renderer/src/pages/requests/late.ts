/**
 * Whether a time-off request came in after the period's request window closed. The closing date
 * is a calendar day on the ward; a request made any time that day, on this machine's clock, is
 * on time. Display only: a late request is decided first-come with a cover plan, never refused.
 */

import type { IsoDate } from '@shiftnurse/core';

export function isLateRequest(submittedAt: number, closesOn: IsoDate | undefined): boolean {
  if (closesOn === undefined || submittedAt <= 0) return false;
  const [y, m, d] = closesOn.split('-').map(Number);
  // The one sanctioned local `Date` built from an IsoDate: `closesOn` is a calendar date and
  // `submittedAt` a real instant, and "after the close date" means after the local midnight that
  // ends that day on the ward's clock, so this is the date/instant boundary, not schedule maths.
  const endOfDay = new Date(y!, m! - 1, d! + 1).getTime();
  return submittedAt >= endOfDay;
}
