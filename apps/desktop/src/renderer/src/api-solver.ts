/**
 * Generate-flow hooks: start a batch of variations, poll it while it runs, then page through,
 * preview, compare and save the candidates it produced.
 *
 * A batch is a job, not a query: `start` returns at once and the variations arrive later. The
 * period's batch lives under one query key, `current(periodId)`, which polls the batch's status
 * while it runs and otherwise asks main for the period's batch — the call that re-checks it
 * against today's inputs, so a batch that went stale says so the next time the page looks.
 * Nothing touches the draft until `save`, and only then is every read of the period refreshed.
 */

import type { Id, SolverSettings } from '@shiftnurse/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SolveBatchOptions, SolveBatchStatus } from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { invalidatePeriod } from './period-cache.js';

export const solverKeys = {
  current: (periodId: Id) => ['solver', 'current', periodId] as const,
  /** Everything scored against the period's draft: refreshed whenever the draft changes. */
  againstDraft: (periodId: Id) => ['solver', 'draft', periodId] as const,
  candidate: (periodId: Id, batchId: Id, index: number) =>
    ['solver', 'draft', periodId, 'candidate', batchId, index] as const,
  compare: (periodId: Id, batchId: Id) =>
    ['solver', 'draft', periodId, 'compare', batchId] as const,
  estimate: (periodId: Id, options: SolveBatchOptions) =>
    ['solver', 'estimate', periodId, options] as const,
  settings: (unitId: Id) => ['solver', 'settings', unitId] as const,
  availability: () => ['solver', 'availability'] as const,
};

/** The unit's saved solver; hybrid when it never saved one. */
export function useSolverSettings(unitId: Id | undefined) {
  return useQuery({
    queryKey: solverKeys.settings(unitId ?? ''),
    queryFn: () => api.solverSettings.get(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useSaveSolverSettings(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (settings: SolverSettings) => api.solverSettings.save(unitId as Id, settings),
    onSettled: () => {
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: solverKeys.settings(unitId) });
      }
    },
  });
}

/** Which backends this install can run; fixed for the life of the process. */
export function useSolverAvailability() {
  return useQuery({
    queryKey: solverKeys.availability(),
    queryFn: () => api.solver.available(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const POLL_MS = 250;

/**
 * The period's batch, or null. Polls the batch's own status while it runs (cheap), and asks for
 * the period's batch otherwise (which re-checks it against today's inputs).
 */
export function useCurrentBatch(periodId: Id) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: solverKeys.current(periodId),
    queryFn: async (): Promise<SolveBatchStatus | null> => {
      const previous = queryClient.getQueryData<SolveBatchStatus | null>(
        solverKeys.current(periodId),
      );
      if (previous?.state === 'running') {
        return (await api.solver.status(previous.id)) ?? null;
      }
      return (await api.solver.current(periodId)) ?? null;
    },
    refetchInterval: (q) => (q.state.data?.state === 'running' ? POLL_MS : false),
    // Keep polling while the window is not focused. TanStack pauses intervals in the background
    // by default, so a manager who switched to email mid-run came back to a batch frozen at its
    // start — and the smoke run, whose window never has focus, waited 10–70 s for a batch that
    // had finished in one.
    refetchIntervalInBackground: true,
  });
}

export function useStartBatch(periodId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (options: SolveBatchOptions) => api.solver.start(periodId, options),
    onSuccess: (status) => queryClient.setQueryData(solverKeys.current(periodId), status),
  });
}

export function useCancelBatch(periodId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: Id) => api.solver.cancel(batchId),
    onSuccess: (status) => {
      if (status) queryClient.setQueryData(solverKeys.current(periodId), status);
    },
  });
}

export function useDiscardBatch(periodId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: Id) => api.solver.discard(batchId),
    onSuccess: () => queryClient.setQueryData(solverKeys.current(periodId), null),
  });
}

/** Write one variation to the draft; every read of the period changes with it. */
export function useSaveCandidate(periodId: Id, unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ batchId, index }: { batchId: Id; index: number }) =>
      api.solver.save(batchId, index),
    onSettled: () => {
      invalidatePeriod(queryClient, periodId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    },
  });
}

export function useBatchEstimate(periodId: Id, options: SolveBatchOptions, enabled: boolean) {
  return useQuery({
    queryKey: solverKeys.estimate(periodId, options),
    queryFn: () => api.solver.estimate(periodId, options),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCandidatePreview(
  periodId: Id,
  batchId: Id | undefined,
  index: number | undefined,
) {
  return useQuery({
    queryKey: solverKeys.candidate(periodId, batchId ?? '', index ?? -1),
    queryFn: () => api.solver.candidate(batchId as Id, index as number),
    enabled: batchId !== undefined && index !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useComparison(periodId: Id, batchId: Id | undefined, enabled: boolean) {
  return useQuery({
    queryKey: solverKeys.compare(periodId, batchId ?? ''),
    queryFn: () => api.solver.compare(batchId as Id),
    enabled: enabled && batchId !== undefined,
    retry: false,
  });
}
