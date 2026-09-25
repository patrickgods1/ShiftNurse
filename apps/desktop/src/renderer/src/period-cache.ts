/**
 * Everything derived from one period's assignments, refreshed together.
 *
 * Five mutation families write assignments — grid edits, Generate, call-off backfill, exchange
 * decisions and time-off/conflict decisions — and each used to keep its own list of what to
 * refresh. The lists drifted: after a Generate or a backfill the compliance alerts and publish
 * preview kept showing the old schedule, while grid edits never refreshed fairness. One list,
 * used by all five, is the fix; a new read model derived from assignments belongs here.
 *
 * The imports below are cyclic with the hook modules (they import this back), which is safe:
 * the key functions are only read when a mutation settles, long after every module loaded.
 */

import type { Id } from '@shiftnurse/core';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './api.js';
import { costKeys } from './api-cost.js';
import { fairnessQueryKeys } from './api-fairness.js';
import { publishKeys } from './api-publish.js';
import { requestKeys } from './api-requests.js';
import { scheduleKeys } from './api-schedule.js';

export function invalidatePeriod(queryClient: QueryClient, periodId: Id): void {
  for (const queryKey of [
    queryKeys.assignments(periodId),
    scheduleKeys.validation(periodId),
    costKeys.report(periodId),
    fairnessQueryKeys.report(periodId),
    requestKeys.conflicts(periodId),
    publishKeys.preview(periodId),
    publishKeys.changes(periodId),
    publishKeys.alerts(periodId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
