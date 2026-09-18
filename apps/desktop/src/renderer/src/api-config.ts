/**
 * Query keys, queries and mutations for the unit-configuration screens (shift types, coverage
 * floors, holidays). Kept separate from `api.ts` — which another change is actively
 * extending for roster/nurse concerns — so the two files don't collide on the same lines.
 * Mutations here invalidate both their own list and `['dashboard', unitId]`, because the
 * dashboard summary reads today's on-shift roster and coverage-derived counts that shift-type
 * and coverage edits can change.
 */

import type { Holiday, Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CoverageRequirementInput, ShiftTypeInput, ShiftTypePatch } from '../../shared/api.js';
import { api, queryKeys } from './api.js';

export const configKeys = {
  // Same spelling as `queryKeys.shiftTypes` in api.ts, so a mutation here and the existing
  // `useShiftTypes` list hook share one cache entry instead of drifting into two.
  shiftTypes: (unitId: Id) => queryKeys.shiftTypes(unitId),
  coverage: (unitId: Id) => ['coverage', unitId] as const,
  holidays: (unitId: Id) => ['holidays', unitId] as const,
};

function dashboardKey(unitId: Id) {
  return ['dashboard', unitId] as const;
}

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

export function useShiftTypesList(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.shiftTypes(unitId ?? ''),
    queryFn: () => api.shiftTypes.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ShiftTypeInput) => api.shiftTypes.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: configKeys.shiftTypes(created.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(created.unitId) });
    },
  });
}

export function useUpdateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: ShiftTypePatch }) =>
      api.shiftTypes.update(id, patch),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.shiftTypes(updated.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(updated.unitId) });
    },
  });
}

export function useDeactivateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.shiftTypes.deactivate(id),
    onSuccess: (deactivated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.shiftTypes(deactivated.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(deactivated.unitId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Coverage requirements
// ---------------------------------------------------------------------------

export function useCoverage(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.coverage(unitId ?? ''),
    queryFn: () => api.coverage.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useUpsertCoverage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CoverageRequirementInput) => api.coverage.upsert(input),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: configKeys.coverage(saved.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(saved.unitId) });
    },
  });
}

export function useDeleteCoverage() {
  const queryClient = useQueryClient();
  return useMutation({
    // `coverage.delete` returns void, so the unit id has to travel with the call for
    // cache invalidation — the caller always has it (it's reading the unit's own grid).
    mutationFn: ({ id }: { id: Id; unitId: Id }) => api.coverage.delete(id),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.coverage(variables.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(variables.unitId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export function useHolidays(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.holidays(unitId ?? ''),
    queryFn: () => api.holidays.list(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<Holiday, 'id'>) => api.holidays.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: configKeys.holidays(created.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(created.unitId) });
    },
  });
}

export function useDeleteHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    // Same shape as `useDeleteCoverage`: `holidays.delete` returns void.
    mutationFn: ({ id }: { id: Id; unitId: Id }) => api.holidays.delete(id),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.holidays(variables.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(variables.unitId) });
    },
  });
}
