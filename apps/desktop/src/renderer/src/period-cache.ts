/**
 * What each kind of write refreshes. There are three kinds:
 *
 * - **Assignments** — a grid edit, saving a Generate variation, a backfill, an exchange, a float,
 *   a holdover, a census cancellation, a resolution. Everything read from a schedule changes.
 * - **Leave** — a time-off or leave-bid decision. The request lists and leave checks change, and
 *   an approval lifts the nurse's shifts from every draft period it touches, so it is also an
 *   assignment write.
 * - **Configuration** — rules, coverage, shift types, tiers, ratios, the HPPD target, the roster,
 *   pay, policies. Every period's verdicts and prices change, though no assignment did.
 *
 * Each helper refreshes by root, across every period, rather than the one period a hook was told
 * about. Invalidation refetches only mounted queries, so marking every period stale costs no more
 * refetches than one period, and a write never has to know which periods it touched — an
 * approval straddling two drafts, or a published edit that is the next draft's lookback tail,
 * used to leave the other period on its old answer until the app was restarted.
 *
 * A new read model joins every root set below whose writes change its answer.
 */

import type { QueryClient } from '@tanstack/react-query';
import { queryRoots } from './query-roots.js';

const ASSIGNMENT_ROOTS = [
  queryRoots.assignments,
  queryRoots.validation,
  queryRoots.nurseHours,
  queryRoots.conflicts,
  queryRoots.coverOptions,
  queryRoots.timeOffImpact,
  queryRoots.costReport,
  queryRoots.fairnessReport,
  queryRoots.publishPreview,
  queryRoots.publishChanges,
  queryRoots.publishAlerts,
  queryRoots.solverCurrent,
  queryRoots.solverDraft,
  queryRoots.scheduledHppd,
  queryRoots.dayOf,
  queryRoots.exchange,
  queryRoots.floatOut,
  queryRoots.dashboard,
] as const;

const LEAVE_ROOTS = [
  ...ASSIGNMENT_ROOTS,
  queryRoots.timeOff,
  queryRoots.leaveBalances,
  queryRoots.leaveBidRounds,
  queryRoots.leaveBids,
] as const;

const CONFIG_ROOTS = [
  queryRoots.validation,
  queryRoots.nurseHours,
  queryRoots.conflicts,
  queryRoots.coverOptions,
  queryRoots.timeOffImpact,
  queryRoots.holidayWorkPriority,
  queryRoots.demand,
  queryRoots.scheduledHppd,
  queryRoots.costReport,
  queryRoots.fairnessReport,
  queryRoots.publishPreview,
  queryRoots.publishAlerts,
  queryRoots.solverCurrent,
  queryRoots.solverDraft,
  queryRoots.dayOf,
  queryRoots.exchange,
  queryRoots.floatOut,
  queryRoots.dashboard,
] as const;

function invalidateRoots(queryClient: QueryClient, roots: readonly (readonly string[])[]): void {
  for (const queryKey of roots) void queryClient.invalidateQueries({ queryKey });
}

/** A write that adds, moves, edits or removes assignments in ANY period (grid edit, Generate save, backfill, exchange, float, holdover, census cancel, resolution). */
export function afterAssignmentsChange(queryClient: QueryClient): void {
  invalidateRoots(queryClient, ASSIGNMENT_ROOTS);
}

/** A time-off or leave-bid decision: request lists, leave checks, bids, plus everything afterAssignmentsChange refreshes (approvals lift shifts from every draft period). */
export function afterLeaveChange(queryClient: QueryClient): void {
  invalidateRoots(queryClient, LEAVE_ROOTS);
}

/** Configuration that judges or prices schedules (rules, coverage, shift types, tiers, ratios, HPPD target, roster, pay, policies). */
export function afterConfigChange(queryClient: QueryClient): void {
  invalidateRoots(queryClient, CONFIG_ROOTS);
}

/** Everything, for writes that replace the database's contents (demo load, start over, float memberships). */
export function refreshEverything(queryClient: QueryClient): void {
  void queryClient.invalidateQueries();
}
