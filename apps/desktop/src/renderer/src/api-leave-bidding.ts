/**
 * Leave-bidding hooks, split out like `api-requests.ts`.
 *
 * Entering a bid only changes that round's list. The award is the one that reaches further: each
 * award is approved PTO, and approving takes the nurse off every draft shift on those days, so it
 * refreshes time off, the grids' assignments, and everything derived from them (validation, cost,
 * conflicts, the dashboard). Invalidation runs in `onSettled` so a refused award — one already
 * made — still snaps the screen back to what the database holds.
 */

import type { Id, LeaveBidChoice } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LeaveBidRoundInput, LeaveBidRoundPatch } from '../../shared/api.js';
import { api } from './api.js';
import { invalidateUnitDerived } from './period-cache.js';

export const leaveBidKeys = {
  rounds: (unitId: Id) => ['leaveBidRounds', unitId] as const,
  bids: (roundId: Id) => ['leaveBids', roundId] as const,
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
    mutationFn: ({ id, patch }: { id: Id; patch: LeaveBidRoundPatch }) =>
      api.leaveBidding.updateRound(id, patch),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: leaveBidKeys.rounds(unitId) }),
  });
}

export function useCloseLeaveBidRound(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.leaveBidding.closeRound(id),
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

export function useAwardLeaveBidRound(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (roundId: Id) => api.leaveBidding.award(roundId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: leaveBidKeys.rounds(unitId) });
      void queryClient.invalidateQueries({ queryKey: ['leaveBids'] });
      void queryClient.invalidateQueries({ queryKey: ['timeOff'] });
      // Lifted draft shifts: every period's grid, not only the one on screen.
      void queryClient.invalidateQueries({ queryKey: ['assignments'] });
      invalidateUnitDerived(queryClient, unitId);
    },
  });
}
