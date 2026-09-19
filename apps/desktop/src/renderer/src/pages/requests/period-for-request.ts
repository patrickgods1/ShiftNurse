/**
 * Which period a request's impact should be judged against. A request can be decided with no
 * period at all (the manager approves March leave in January), so this may return nothing;
 * when several periods touch the range — a request straddling a boundary — the draft wins,
 * because that is the schedule still open to change, and otherwise the one containing the
 * request's start date.
 */

import type { SchedulePeriod, TimeOffRequest } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';

export function periodForRequest(
  periods: readonly SchedulePeriod[],
  request: Pick<TimeOffRequest, 'startDate' | 'endDate'>,
): SchedulePeriod | undefined {
  const touching = periods.filter(
    (p) =>
      compareDates(p.startDate, request.endDate) <= 0 &&
      compareDates(p.endDate, request.startDate) >= 0,
  );
  if (touching.length === 0) return undefined;
  const drafts = touching.filter((p) => p.status === 'draft');
  const pool = drafts.length > 0 ? drafts : touching;
  return (
    pool.find(
      (p) =>
        compareDates(p.startDate, request.startDate) <= 0 &&
        compareDates(p.endDate, request.startDate) >= 0,
    ) ?? [...pool].sort((a, b) => compareDates(a.startDate, b.startDate))[0]
  );
}
