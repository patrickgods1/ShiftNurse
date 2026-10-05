/**
 * Leave balances, FMLA certifications and the check a request is shown against them. The check
 * depends on the balance, the certifications and the nurse's approved FMLA leave, so a change to
 * any of them refreshes every open check; approving or cancelling FMLA time off also moves it,
 * which `api-requests` covers by invalidating `['timeOff']` — the check is keyed under its own
 * prefix and refetches when a dialog opens.
 */

import type {
  FmlaCertificationInput,
  FmlaCertificationPatch,
  LeaveRequestCheck,
} from '@shared/api.js';
import type { Id, IsoDate, TimeOffType } from '@shiftnurse/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

export const leaveKeys = {
  records: (nurseId: Id) => ['leaveBalances', 'records', nurseId] as const,
  check: (nurseId: Id, type: TimeOffType, start: IsoDate, end: IsoDate, paidHours: number) =>
    ['leaveBalances', 'check', nurseId, type, start, end, paidHours] as const,
};

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
  return () => void queryClient.invalidateQueries({ queryKey: ['leaveBalances'] });
}

export function useSetLeaveBalance(nurseId: Id) {
  const invalidate = useInvalidateLeave();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (v: { type: 'pto' | 'sick'; balanceHours: number; asOf: IsoDate }) =>
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

/** Warnings only; `enabled` stays false until the form has a nurse and a real date range. */
export function useLeaveRequestCheck(
  args:
    | { nurseId: Id; type: TimeOffType; start: IsoDate; end: IsoDate; paidHours: number }
    | undefined,
) {
  return useQuery<LeaveRequestCheck>({
    queryKey: args
      ? leaveKeys.check(args.nurseId, args.type, args.start, args.end, args.paidHours)
      : ['leaveBalances', 'check', 'none'],
    queryFn: () =>
      api.leaveBalances.checkRequest(
        (args as NonNullable<typeof args>).nurseId,
        (args as NonNullable<typeof args>).type,
        (args as NonNullable<typeof args>).start,
        (args as NonNullable<typeof args>).end,
        (args as NonNullable<typeof args>).paidHours,
      ),
    enabled: args !== undefined,
    placeholderData: keepPreviousData,
  });
}
