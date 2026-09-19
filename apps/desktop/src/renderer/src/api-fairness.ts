/**
 * Fairness query keys and hooks, split out like `api-demand.ts` and `api-schedule.ts` so this
 * milestone's data layer doesn't collide with files other agents are editing concurrently.
 *
 * A history import can rewrite ledger rows for any past period (see `replacesExisting` on
 * `HistoryImportPeriodPreview`), and the burden window that scores a *current* draft looks back
 * across recent ledger periods — so a new import can change what today's report says even
 * though today's period itself didn't change. That is why `useImportHistory` invalidates every
 * cached `fairness.report` query for the unit rather than one period's.
 */

import type { HistoricalShiftRow, Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

export const fairnessQueryKeys = {
  report: (periodId: Id) => ['fairness', 'report', periodId] as const,
  history: (unitId: Id) => ['fairness', 'history', unitId] as const,
  trend: (unitId: Id) => ['fairness', 'trend', unitId] as const,
};

export function useFairnessReport(periodId: Id | undefined) {
  return useQuery({
    queryKey: fairnessQueryKeys.report(periodId ?? ''),
    queryFn: () => api.fairness.report(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useFairnessHistory(unitId: Id | undefined) {
  return useQuery({
    queryKey: fairnessQueryKeys.history(unitId ?? ''),
    queryFn: () => api.fairness.history(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useFairnessTrend(unitId: Id | undefined) {
  return useQuery({
    queryKey: fairnessQueryKeys.trend(unitId ?? ''),
    queryFn: () => api.fairness.trend(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function usePickHistoryImportFile() {
  return useMutation({
    mutationFn: (unitId: Id) => api.fairness.pickHistoryImportFile(unitId),
  });
}

export function useImportHistory(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rows: HistoricalShiftRow[]) => api.fairness.importHistory(unitId as Id, rows),
    onSuccess: () => {
      if (unitId === undefined) return;
      void queryClient.invalidateQueries({ queryKey: fairnessQueryKeys.history(unitId) });
      void queryClient.invalidateQueries({ queryKey: fairnessQueryKeys.trend(unitId) });
      // Every period's report can shift once new ledger history lands (it feeds each nurse's
      // burden window), so invalidate the whole 'report' family instead of tracking which
      // period ids happen to be cached.
      void queryClient.invalidateQueries({ queryKey: ['fairness', 'report'] });
    },
  });
}
