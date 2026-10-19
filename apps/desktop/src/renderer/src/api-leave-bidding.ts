/**
 * Leave-bidding hooks, split out like `api-requests.ts`.
 *
 * Entering a bid only changes that round's list. The award is the one that reaches further: each
 * award is approved PTO, and approving takes the nurse off every draft shift on those days, so it
 * refreshes through `afterLeaveChange`: time off, leave checks, bids, and every period's
 * assignments and everything derived from them. Invalidation runs in `onSettled` so a refused
 * award — one already made — still snaps the screen back to what the database holds.
 */

import type { Id, LeaveBidChoice } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaveBidRoundInput, LeaveBidRoundPatch } from '../../shared/api.js';
import { api } from './api.js';
import { afterLeaveChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const leaveBidKeys = {
  rounds: (unitId: Id) => [...queryRoots.leaveBidRounds, unitId] as const,
  bids: (roundId: Id) => [...queryRoots.leaveBids, roundId] as const,
};

export function useLeaveBidRounds(unitId: Id | undefined) {
  return useQuery({
    queryKey: leaveBidKeys.rounds(unitId ?? ''),
    queryFn: () => api.leaveBidding.rounds(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useLeaveBids(roundId: Id | undefined) {
  return useQuery({
    queryKey: leaveBidKeys.bids(roundId ?? ''),
    queryFn: () => api.leaveBidding.bids(roundId as Id),
    enabled: roundId !== undefined,
  });
}

export function useCreateLeaveBidRound(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: LeaveBidRoundInput) => api.leaveBidding.createRound(input),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: leaveBidKeys.rounds(unitId) }),
  });
}

export function useUpdateLeaveBidRound(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch, reason }: { id: Id; patch: LeaveBidRoundPatch; reason?: string }) =>
      api.leaveBidding.updateRound(id, patch, reason),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: leaveBidKeys.rounds(unitId) }),
  });
}

export function useCloseLeaveBidRound(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason?: string }) =>
      api.leaveBidding.closeRound(id, reason),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: leaveBidKeys.rounds(unitId) }),
  });
}

export function useSubmitLeaveBid(roundId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ nurseId, choices }: { nurseId: Id; choices: LeaveBidChoice[] }) =>
      api.leaveBidding.submitBid(roundId, nurseId, choices),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: leaveBidKeys.bids(roundId) }),
  });
}

export function useAwardLeaveBidRound(_unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (roundId: Id) => api.leaveBidding.award(roundId),
    // Lifted draft shifts: every period's grid, not only the one on screen.
    onSettled: () => afterLeaveChange(queryClient),
  });
}
