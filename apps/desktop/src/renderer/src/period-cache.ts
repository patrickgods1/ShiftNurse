/**
 * Everything derived from one period's assignments, refreshed together.
 *
 * Five mutation families write assignments — grid edits, saving a Generate variation, call-off backfill, exchange
 * decisions and time-off/conflict decisions — and each used to keep its own list of what to
 * refresh. The lists drifted: after a Generate or a backfill the compliance alerts and publish
 * preview kept showing the old schedule, while grid edits never refreshed fairness. One list,
 * used by all five, is the fix; a new read model derived from assignments belongs here.
 *
 * The imports below are cyclic with the hook modules (they import this back), which is safe:
 * the key functions are only read when a mutation settles, long after every module loaded.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './api.js';
import { costKeys } from './api-cost.js';
import { dayOfKeys } from './api-dayof.js';
import { demandQueryKeys } from './api-demand.js';
import { exchangeKeys } from './api-exchange.js';
import { fairnessQueryKeys } from './api-fairness.js';
import { publishKeys } from './api-publish.js';
import { requestKeys } from './api-requests.js';
import { scheduleKeys } from './api-schedule.js';
import { solverKeys } from './api-solver.js';

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
    // Generate's candidates are compared with the draft and re-checked against its inputs.
    solverKeys.current(periodId),
    solverKeys.againstDraft(periodId),
    // Scheduled hours per patient day, shown beside the demand target.
    demandQueryKeys.hppd(periodId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Configuration (rules, coverage, shift types, roster, pay) feeds every period's derived views,
 * and the mounted grid shows only one of them: a rule edit that left the grid's validation, the
 * conflicts list, alerts and Generate's staleness check on the old answer would read "no
 * violations" for a schedule the new rules reject. So it invalidates by root prefix — every
 * period, cached or not — rather than guessing which periods the screen has open.
 */
export function invalidateUnitDerived(queryClient: QueryClient, unitId: Id): void {
  invalidateDerivedRoots(queryClient);
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
}

/**
 * For a write whose hook is not told its unit (a credential grant, a holiday's recorded work —
 * the payload names a nurse or holiday, not the unit). The app shows one unit at a time, so
 * refreshing every dashboard costs one refetch of what is on screen.
 */
export function invalidateUnitDerivedAnyUnit(queryClient: QueryClient): void {
  invalidateDerivedRoots(queryClient);
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard('').slice(0, 1) });
}

function invalidateDerivedRoots(queryClient: QueryClient): void {
  for (const queryKey of [
    scheduleKeys.validation('').slice(0, 1),
    requestKeys.conflicts('').slice(0, 1),
    demandQueryKeys.demand('', '' as IsoDate, '' as IsoDate).slice(0, 1),
    demandQueryKeys.hppd('').slice(0, 1),
    costKeys.report('').slice(0, 2),
    fairnessQueryKeys.report('').slice(0, 2),
    publishKeys.alerts('').slice(0, 2),
    publishKeys.preview('').slice(0, 2),
    solverKeys.current('').slice(0, 2),
    solverKeys.againstDraft('').slice(0, 2),
    dayOfKeys.today('').slice(0, 1),
    exchangeKeys.forUnit('').slice(0, 1),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
