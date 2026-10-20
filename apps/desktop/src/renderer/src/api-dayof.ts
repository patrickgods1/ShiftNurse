/**
 * Day-of console hooks, split out like `api-exchange.ts`. `dayOf.today` is the one read the
 * page needs on load; call-offs, replacements and the call log are each their own query so a
 * card can refetch its own state (a new call attempt, an accepted backfill) without refetching
 * every other open call-off on the unit.
 *
 * A backfill, a census cancellation and a holdover change assignments, so they refresh through
 * `afterAssignmentsChange` (which covers `dayOf` and the dashboard too). A call-off, a logged call
 * or an uncovered mark changes no assignment until it is backfilled, so those refresh only the
 * console and the dashboard's call-off count.
 */

import type { RecordHoldoverInput } from '@shared/api.js';
import type { CallOutcome, CancellationTier, Id, IsoDate, NurseRole } from '@shiftnurse/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from './api.js';
import { afterAssignmentsChange, afterConfigChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const dayOfKeys = {
  today: (unitId: Id, date?: IsoDate) =>
    [...queryRoots.dayOf, 'today', unitId, date ?? 'now'] as const,
  callOffs: (unitId: Id, start: IsoDate, end: IsoDate) =>
    [...queryRoots.dayOf, 'callOffs', unitId, start, end] as const,
  replacements: (callOffId: Id) => [...queryRoots.dayOf, 'replacements', callOffId] as const,
  callLog: (callOffId: Id) => [...queryRoots.dayOf, 'callLog', callOffId] as const,
  cancellationPolicy: (unitId: Id) => [...queryRoots.dayOf, 'cancellationPolicy', unitId] as const,
  cancellationOrder: (
    periodId: Id,
    date: IsoDate,
    shiftTypeId: Id,
    role: NurseRole,
    volunteers: readonly Id[],
  ) =>
    [
      ...queryRoots.dayOf,
      'cancellationOrder',
      periodId,
      date,
      shiftTypeId,
      role,
      [...volunteers],
    ] as const,
};

export function useToday(unitId: Id | undefined, date?: IsoDate) {
  return useQuery({
    queryKey: dayOfKeys.today(unitId ?? '', date),
    queryFn: () => api.dayOf.today(unitId as Id, date),
    enabled: unitId !== undefined,
  });
}

export function useCallOffsInRange(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  return useQuery({
    queryKey: dayOfKeys.callOffs(unitId ?? '', start, end),
    queryFn: () => api.dayOf.callOffs(unitId as Id, start, end),
    enabled: unitId !== undefined,
  });
}

export function useReplacements(callOffId: Id | undefined) {
  return useQuery({
    queryKey: dayOfKeys.replacements(callOffId ?? ''),
    queryFn: () => api.dayOf.replacements(callOffId as Id),
    enabled: callOffId !== undefined,
  });
}

export function useCallLog(callOffId: Id | undefined) {
  return useQuery({
    queryKey: dayOfKeys.callLog(callOffId ?? ''),
    queryFn: () => api.dayOf.callLog(callOffId as Id),
    enabled: callOffId !== undefined,
  });
}

/** Every mutation below touches this: the console's own read and the dashboard's call-off count. */
function useInvalidateDayOf(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryRoots.dayOf });
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  };
}

export function useReportCallOff(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      assignmentId,
      reason,
      paidSickHours,
    }: {
      assignmentId: Id;
      reason?: string;
      paidSickHours?: number;
    }) => api.dayOf.reportCallOff(assignmentId, reason, paidSickHours),
    onSettled: invalidate,
  });
}

export function useLogCall(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    mutationFn: ({
      callOffId,
      nurseId,
      outcome,
      notes,
    }: {
      callOffId: Id;
      nurseId: Id;
      outcome: Exclude<CallOutcome, 'accepted'>;
      notes?: string;
    }) => api.dayOf.logCall(callOffId, nurseId, outcome, notes),
    onSettled: invalidate,
  });
}

export function useBackfill(_unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ callOffId, nurseId, notes }: { callOffId: Id; nurseId: Id; notes?: string }) =>
      api.dayOf.backfill(callOffId, nurseId, notes),
    onSettled: () => afterAssignmentsChange(queryClient),
  });
}

export function useMarkUncovered(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ callOffId, reason }: { callOffId: Id; reason: string }) =>
      api.dayOf.markUncovered(callOffId, reason),
    onSettled: invalidate,
  });
}

export function useCancelCallOff(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ callOffId, reason }: { callOffId: Id; reason: string }) =>
      api.dayOf.cancelCallOff(callOffId, reason),
    onSettled: invalidate,
  });
}

export function useCancellationPolicy(unitId: Id | undefined) {
  return useQuery({
    queryKey: dayOfKeys.cancellationPolicy(unitId ?? ''),
    queryFn: () => api.dayOf.cancellationPolicy(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useSaveCancellationPolicy(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (tiers: CancellationTier[]) =>
      api.dayOf.saveCancellationPolicy(unitId as Id, tiers),
    // The order is what every open "who goes home" list is ranked by.
    onSettled: () => afterConfigChange(queryClient),
  });
}

/** Who goes home first on a shift over its requirement; volunteers re-rank it. */
export function useCancellationOrder(
  periodId: Id,
  date: IsoDate,
  shiftTypeId: Id,
  role: NurseRole,
  volunteers: readonly Id[],
) {
  return useQuery({
    queryKey: dayOfKeys.cancellationOrder(periodId, date, shiftTypeId, role, volunteers),
    queryFn: () => api.dayOf.cancellationOrder(periodId, date, shiftTypeId, role, [...volunteers]),
    // Always enabled, so keepPreviousData is safe here (see placeholderWhileEnabled elsewhere):
    // ticking a volunteer re-ranks the list; keep the old one up rather than flashing a spinner.
    placeholderData: keepPreviousData,
  });
}

/** Removes a shift like a backfill does, so the grid, cost and conflicts refresh with Today. */
export function useCancelForCensus(_unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (args: {
      periodId: Id;
      date: IsoDate;
      shiftTypeId: Id;
      role: NurseRole;
      volunteers: readonly Id[];
      nurseId: Id;
    }) =>
      api.dayOf.cancelForCensus(
        args.periodId,
        args.date,
        args.shiftTypeId,
        args.role,
        [...args.volunteers],
        args.nurseId,
      ),
    onSettled: () => afterAssignmentsChange(queryClient),
  });
}

/** A holdover changes the assignment itself, so every read of the schedule refreshes. */
export function useRecordHoldover(_unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: RecordHoldoverInput) => api.dayOf.recordHoldover(input),
    onSettled: () => afterAssignmentsChange(queryClient),
  });
}
