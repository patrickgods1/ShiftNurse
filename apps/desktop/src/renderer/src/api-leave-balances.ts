/**
 * Leave balances, FMLA certifications, comp-time elections and the check a request is shown against them. The check
 * depends on the balance, the certifications and the nurse's approved leave, so a balance or
 * certification write refreshes every open check; a time-off decision or bid award moves it too,
 * and refreshes it through `afterLeaveChange` in `period-cache.ts`.
 */

import type {
  CompTimeElectionInput,
  CompTimeElectionPatch,
  FmlaCertificationInput,
  FmlaCertificationPatch,
  LeaveRequestCheck,
} from '@shared/api.js';
import type { Id, IsoDate, LeaveBalanceType, TimeOffType } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { placeholderWhileEnabled } from './query-client.js';
import { queryRoots } from './query-roots.js';

export const leaveKeys = {
  records: (nurseId: Id) => [...queryRoots.leaveBalances, 'records', nurseId] as const,
  check: (nurseId: Id, type: TimeOffType, start: IsoDate, end: IsoDate, paidHours: number) =>
    [...queryRoots.leaveBalances, 'check', nurseId, type, start, end, paidHours] as const,
  /** The disabled check's key, before the form has a nurse and a range. */
  noCheck: () => [...queryRoots.leaveBalances, 'check', 'none'] as const,
};

export function useCompElections(nurseId: Id | undefined) {
  return useQuery({
    queryKey: [...queryRoots.leaveBalances, 'comp-elections', nurseId ?? ''] as const,
    queryFn: () => api.leaveBalances.compElections(nurseId as Id),
    enabled: nurseId !== undefined,
  });
}

export function useLeaveRecords(nurseId: Id | undefined) {
  return useQuery({
    queryKey: leaveKeys.records(nurseId ?? ''),
    queryFn: () => api.leaveBalances.forNurse(nurseId as Id),
    enabled: nurseId !== undefined,
  });
}

/** Everything a request's check reads: refetch it all whenever a balance or certification moves. */
function useInvalidateLeave() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: queryRoots.leaveBalances });
}

export function useSetLeaveBalance(nurseId: Id) {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (v: { type: LeaveBalanceType; balanceHours: number; asOf: IsoDate }) =>
      api.leaveBalances.setBalance(nurseId, v.type, v.balanceHours, v.asOf),
    onSuccess: invalidate,
  });
}

export function useAddCertification() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: FmlaCertificationInput) => api.leaveBalances.addCertification(input),
    onSuccess: invalidate,
  });
}

export function useUpdateCertification() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: FmlaCertificationPatch }) =>
      api.leaveBalances.updateCertification(id, patch),
    onSuccess: invalidate,
  });
}

export function useRemoveCertification() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.leaveBalances.removeCertification(id),
    onSuccess: invalidate,
  });
}

export function useAddCompElection() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: CompTimeElectionInput) => api.leaveBalances.addCompElection(input),
    onSuccess: invalidate,
  });
}

export function useUpdateCompElection() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: CompTimeElectionPatch }) =>
      api.leaveBalances.updateCompElection(id, patch),
    onSuccess: invalidate,
  });
}

export function useRemoveCompElection() {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.leaveBalances.removeCompElection(id),
    onSuccess: invalidate,
  });
}

/** Warnings only; `enabled` stays false until the form has a nurse and a real date range. */
export function useLeaveRequestCheck(
  args:
    | { nurseId: Id; type: TimeOffType; start: IsoDate; end: IsoDate; paidHours: number }
    | undefined,
) {
  return useQuery<LeaveRequestCheck>({
    queryKey: args
      ? leaveKeys.check(args.nurseId, args.type, args.start, args.end, args.paidHours)
      : leaveKeys.noCheck(),
    queryFn: () =>
      api.leaveBalances.checkRequest(
        (args as NonNullable<typeof args>).nurseId,
        (args as NonNullable<typeof args>).type,
        (args as NonNullable<typeof args>).start,
        (args as NonNullable<typeof args>).end,
        (args as NonNullable<typeof args>).paidHours,
      ),
    enabled: args !== undefined,
    // Not keepPreviousData: cleared dates must not keep the last range's answer on screen.
    placeholderData: placeholderWhileEnabled(args !== undefined),
  });
}
