/**
 * Time-off and conflict hooks, split out like the other `api-*.ts` files.
 *
 * Deciding a request or applying a resolution changes more than the row it touches: an
 * approval removes a nurse from the pool the solver, the grid's validation, the cost report
 * and the fairness score all read, and a resolution writes assignments directly. So every
 * mutation here invalidates the whole period family — assignments, validation, cost,
 * fairness, conflicts — plus the unit's request lists and dashboard, rather than guessing
 * which of them the change happened to move. Invalidation runs in `onSettled` so a refused
 * mutation (a denial with no reason, a stale resolution) still snaps the screen back to what
 * the database holds.
 */

import type { AutoResolvePolicy, Id, IsoDate, Resolution } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTimeOffInput } from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { invalidatePeriod } from './period-cache.js';

export const requestKeys = {
  inRange: (unitId: Id, start: IsoDate, end: IsoDate) =>
    ['timeOff', 'range', unitId, start, end] as const,
  impact: (periodId: Id, requestId: Id, decision: 'approved' | 'denied') =>
    ['timeOff', 'impact', periodId, requestId, decision] as const,
  conflicts: (periodId: Id) => ['conflicts', periodId] as const,
  policy: (unitId: Id) => ['conflictPolicy', unitId] as const,
};

export function useTimeOffInRange(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  return useQuery({
    queryKey: requestKeys.inRange(unitId ?? '', start, end),
    queryFn: () => api.timeOff.listInRange(unitId as Id, start, end),
    enabled: unitId !== undefined,
  });
}

export function useTimeOffImpact(
  periodId: Id | undefined,
  requestId: Id | undefined,
  decision: 'approved' | 'denied',
) {
  return useQuery({
    queryKey: requestKeys.impact(periodId ?? '', requestId ?? '', decision),
    queryFn: () => api.timeOff.impact(periodId as Id, requestId as Id, decision),
    enabled: periodId !== undefined && requestId !== undefined,
  });
}

export function useConflictReport(periodId: Id | undefined) {
  return useQuery({
    queryKey: requestKeys.conflicts(periodId ?? ''),
    queryFn: () => api.conflicts.analyse(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useConflictPolicy(unitId: Id | undefined) {
  return useQuery({
    queryKey: requestKeys.policy(unitId ?? ''),
    queryFn: () => api.conflicts.policy(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useSaveConflictPolicy(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: AutoResolvePolicy) => api.conflicts.savePolicy(unitId as Id, policy),
    onSettled: () => {
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: requestKeys.policy(unitId) });
      }
    },
  });
}

/** Everything a time-off decision or a resolution can move, for one unit and (maybe) one period. */
function useInvalidateRequests(unitId: Id | undefined, periodId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: ['timeOff'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
    if (periodId !== undefined) invalidatePeriod(queryClient, periodId);
  };
}

export function useCreateTimeOff(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: (input: CreateTimeOffInput) => api.timeOff.create(input),
    onSettled: invalidate,
  });
}

export function useApproveTimeOff(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: Id; reason?: string }) => api.timeOff.approve(id, reason),
    onSettled: invalidate,
  });
}

export function useDenyTimeOff(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: Id; reason: string }) => api.timeOff.deny(id, reason),
    onSettled: invalidate,
  });
}

export function useCancelTimeOff(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: Id; reason?: string }) => api.timeOff.cancel(id, reason),
    onSettled: invalidate,
  });
}

export function useWithdrawApproval(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: Id; reason: string }) =>
      api.timeOff.withdrawApproval(id, reason),
    onSettled: invalidate,
  });
}

export function useResolveConflict(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: ({ resolution, reason }: { resolution: Resolution; reason: string }) =>
      api.conflicts.resolve(periodId as Id, resolution, reason),
    onSettled: invalidate,
  });
}

export function useAutoResolve(unitId: Id | undefined, periodId: Id | undefined) {
  const invalidate = useInvalidateRequests(unitId, periodId);
  return useMutation({
    mutationFn: () => api.conflicts.autoResolve(periodId as Id),
    onSettled: invalidate,
  });
}
