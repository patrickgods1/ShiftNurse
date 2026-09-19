/**
 * Cost query keys and hooks: pay configuration (rates, differentials, overtime rules), the
 * per-period cost report, and the budget.
 *
 * Any change to pay configuration re-prices every period, so those mutations invalidate the
 * whole `['cost', 'report']` family rather than tracking which period ids happen to be cached —
 * the same reasoning `api-fairness.ts` gives for a history import. A schedule edit re-prices
 * one period; `api-schedule.ts` invalidates that period's report alongside its validation.
 */

import type { Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DifferentialInput,
  DifferentialPatch,
  OvertimeRuleInput,
  OvertimeRulePatch,
  PayRateInput,
  PayRatePatch,
} from '../../shared/api.js';
import { api } from './api.js';

export const costKeys = {
  payRates: (unitId: Id) => ['cost', 'payRates', unitId] as const,
  differentials: (unitId: Id) => ['cost', 'differentials', unitId] as const,
  overtimeRules: (unitId: Id) => ['cost', 'overtimeRules', unitId] as const,
  report: (periodId: Id) => ['cost', 'report', periodId] as const,
};

export function useCostReport(periodId: Id | undefined) {
  return useQuery({
    queryKey: costKeys.report(periodId ?? ''),
    queryFn: () => api.cost.report(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useSetBudget(periodId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (targetDollars: number) => api.cost.setBudget(periodId as Id, targetDollars),
    onSuccess: () => {
      if (periodId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: costKeys.report(periodId) });
      }
    },
  });
}

/** Pay configuration changes re-price every period; drop every cached report. */
function useInvalidateConfig(unitId: Id, key: (typeof costKeys)[keyof typeof costKeys]) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: key(unitId) });
    void queryClient.invalidateQueries({ queryKey: ['cost', 'report'] });
  };
}

// ---------------------------------------------------------------------------
// Pay rates
// ---------------------------------------------------------------------------

export function usePayRates(unitId: Id | undefined) {
  return useQuery({
    queryKey: costKeys.payRates(unitId ?? ''),
    queryFn: () => api.cost.payRates(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreatePayRate(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.payRates);
  return useMutation({
    mutationFn: (input: PayRateInput) => api.cost.createPayRate(input),
    onSuccess: invalidate,
  });
}

export function useUpdatePayRate(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.payRates);
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: PayRatePatch }) =>
      api.cost.updatePayRate(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeletePayRate(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.payRates);
  return useMutation({
    mutationFn: (id: Id) => api.cost.deletePayRate(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Differentials
// ---------------------------------------------------------------------------

export function useDifferentials(unitId: Id | undefined) {
  return useQuery({
    queryKey: costKeys.differentials(unitId ?? ''),
    queryFn: () => api.cost.differentials(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateDifferential(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.differentials);
  return useMutation({
    mutationFn: (input: DifferentialInput) => api.cost.createDifferential(input),
    onSuccess: invalidate,
  });
}

export function useUpdateDifferential(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.differentials);
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: DifferentialPatch }) =>
      api.cost.updateDifferential(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteDifferential(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.differentials);
  return useMutation({
    mutationFn: (id: Id) => api.cost.deleteDifferential(id),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Overtime rules
// ---------------------------------------------------------------------------

export function useOvertimeRules(unitId: Id | undefined) {
  return useQuery({
    queryKey: costKeys.overtimeRules(unitId ?? ''),
    queryFn: () => api.cost.overtimeRules(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateOvertimeRule(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.overtimeRules);
  return useMutation({
    mutationFn: (input: OvertimeRuleInput) => api.cost.createOvertimeRule(input),
    onSuccess: invalidate,
  });
}

export function useUpdateOvertimeRule(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.overtimeRules);
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: OvertimeRulePatch }) =>
      api.cost.updateOvertimeRule(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteOvertimeRule(unitId: Id) {
  const invalidate = useInvalidateConfig(unitId, costKeys.overtimeRules);
  return useMutation({
    mutationFn: (id: Id) => api.cost.deleteOvertimeRule(id),
    onSuccess: invalidate,
  });
}
