/**
 * Shift-exchange hooks, split out like `api-requests.ts`.
 *
 * A decision on an exchange can move assignment rows the same way a resolution does, so it
 * refreshes through `afterAssignmentsChange` (which covers the exchange lists and the dashboard);
 * a proposal moves nothing yet, so it refreshes only those two. `evaluate` is a plain query keyed by the whole proposal so the
 * dialog's live verdict panel refetches on every field change without the caller managing that
 * by hand, and its result is never cached across proposals — approving always re-evaluates on
 * the server from the stored swap regardless of what this query last returned.
 */

import type { ExchangeProposal, Id, ShiftSwapStatus } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from './api.js';
import { afterAssignmentsChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const exchangeKeys = {
  forUnit: (unitId: Id, status?: ShiftSwapStatus) =>
    [...queryRoots.exchange, 'unit', unitId, status ?? 'all'] as const,
  forPeriod: (periodId: Id, status?: ShiftSwapStatus) =>
    [...queryRoots.exchange, 'period', periodId, status ?? 'all'] as const,
  evaluate: (periodId: Id, proposal: ExchangeProposal) =>
    [...queryRoots.exchange, 'evaluate', periodId, proposal] as const,
};

export function useExchangesForUnit(unitId: Id | undefined, status?: ShiftSwapStatus) {
  return useQuery({
    queryKey: exchangeKeys.forUnit(unitId ?? '', status),
    queryFn: () => api.exchange.list(unitId as Id, status),
    enabled: unitId !== undefined,
  });
}

export function useExchangesForPeriod(periodId: Id | undefined, status?: ShiftSwapStatus) {
  return useQuery({
    queryKey: exchangeKeys.forPeriod(periodId ?? '', status),
    queryFn: () => api.exchange.listForPeriod(periodId as Id, status),
    enabled: periodId !== undefined,
  });
}

/** Live evaluation for the "New exchange" and "Decide" dialogs. Disabled until the proposal is
 * complete — a trade with no counterpart assignment yet is not something core can judge. */
export function useEvaluateExchange(
  periodId: Id | undefined,
  proposal: ExchangeProposal | undefined,
) {
  return useQuery({
    queryKey: exchangeKeys.evaluate(periodId ?? '', proposal ?? ({} as ExchangeProposal)),
    queryFn: () => api.exchange.evaluate(periodId as Id, proposal as ExchangeProposal),
    enabled: periodId !== undefined && proposal !== undefined,
  });
}

/** Everything an exchange decision can move: assignments in whichever period it touched. */
function useInvalidateExchanges() {
  const queryClient = useQueryClient();
  return () => afterAssignmentsChange(queryClient);
}

export function useProposeExchange(unitId: Id | undefined, periodId: Id | undefined) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryRoots.exchange });
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  };
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ proposal, reason }: { proposal: ExchangeProposal; reason?: string }) =>
      api.exchange.propose(periodId as Id, proposal, reason),
    onSettled: invalidate,
  });
}

export function useApproveExchange(_unitId: Id | undefined, _periodId: Id | undefined) {
  const invalidate = useInvalidateExchanges();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason?: string }) => api.exchange.approve(id, reason),
    onSettled: invalidate,
  });
}

export function useDenyExchange(_unitId: Id | undefined, _periodId: Id | undefined) {
  const invalidate = useInvalidateExchanges();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason: string }) => api.exchange.deny(id, reason),
    onSettled: invalidate,
  });
}

export function useCancelExchange(_unitId: Id | undefined, _periodId: Id | undefined) {
  const invalidate = useInvalidateExchanges();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, reason }: { id: Id; reason?: string }) => api.exchange.cancel(id, reason),
    onSettled: invalidate,
  });
}
