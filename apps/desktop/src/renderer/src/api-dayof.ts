/**
 * Day-of console hooks, split out like `api-exchange.ts`. `dayOf.today` is the one read the
 * page needs on load; call-offs, replacements and the call log are each their own query so a
 * card can refetch its own state (a new call attempt, an accepted backfill) without refetching
 * every other open call-off on the unit.
 *
 * A backfill moves an assignment the same way a resolution or exchange approval does, so on
 * top of the `dayOf`/dashboard invalidation every other mutation does, it also invalidates the
 * period family for the assignment it just wrote — copied from `useInvalidateExchanges`.
 */

import type { CallOutcome, Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from './api.js';
import { invalidatePeriod } from './period-cache.js';

export const dayOfKeys = {
  today: (unitId: Id, date?: IsoDate) => ['dayOf', 'today', unitId, date ?? 'now'] as const,
  callOffs: (unitId: Id, start: IsoDate, end: IsoDate) =>
    ['dayOf', 'callOffs', unitId, start, end] as const,
  replacements: (callOffId: Id) => ['dayOf', 'replacements', callOffId] as const,
  callLog: (callOffId: Id) => ['dayOf', 'callLog', callOffId] as const,
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
    void queryClient.invalidateQueries({ queryKey: ['dayOf'] });
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  };
}

export function useReportCallOff(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    mutationFn: ({ assignmentId, reason }: { assignmentId: Id; reason?: string }) =>
      api.dayOf.reportCallOff(assignmentId, reason),
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

export function useBackfill(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ callOffId, nurseId, notes }: { callOffId: Id; nurseId: Id; notes?: string }) =>
      api.dayOf.backfill(callOffId, nurseId, notes),
    onSuccess: (result) => {
      invalidatePeriod(queryClient, result.assignment.periodId);
    },
    onSettled: invalidate,
  });
}

export function useMarkUncovered(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    mutationFn: ({ callOffId, reason }: { callOffId: Id; reason: string }) =>
      api.dayOf.markUncovered(callOffId, reason),
    onSettled: invalidate,
  });
}

export function useCancelCallOff(unitId: Id | undefined) {
  const invalidate = useInvalidateDayOf(unitId);
  return useMutation({
    mutationFn: ({ callOffId, reason }: { callOffId: Id; reason: string }) =>
      api.dayOf.cancelCallOff(callOffId, reason),
    onSettled: invalidate,
  });
}
