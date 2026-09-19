/**
 * Query keys, queries and mutations for the unit-configuration screens (shift types, coverage
 * floors, holidays). Kept separate from `api.ts` — which another change is actively
 * extending for roster/nurse concerns — so the two files don't collide on the same lines.
 * Mutations here invalidate both their own list and `['dashboard', unitId]`, because the
 * dashboard summary reads today's on-shift roster and coverage-derived counts that shift-type
 * and coverage edits can change.
 */

import type { Holiday, Id, RuleSet } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcuityTierInput,
  AcuityTierPatch,
  CoverageRequirementInput,
  RatioRuleInput,
  RatioRulePatch,
  ShiftTypeInput,
  ShiftTypePatch,
} from '../../shared/api.js';
import { api, queryKeys } from './api.js';

export const configKeys = {
  // Same spelling as `queryKeys.shiftTypes` in api.ts, so a mutation here and the existing
  // `useShiftTypes` list hook share one cache entry instead of drifting into two.
  shiftTypes: (unitId: Id) => queryKeys.shiftTypes(unitId),
  coverage: (unitId: Id) => ['coverage', unitId] as const,
  holidays: (unitId: Id) => ['holidays', unitId] as const,
  acuityTiers: (unitId: Id) => ['acuityTiers', unitId] as const,
  ratioRules: (unitId: Id) => ['ratioRules', unitId] as const,
  hppd: (unitId: Id) => ['hppd', unitId] as const,
  rules: (unitId: Id) => ['rules', unitId] as const,
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

// ---------------------------------------------------------------------------
// Acuity tiers, ratio rules and the HPPD target
//
// All three feed `acuity/demand.ts`'s derivation of per-shift staffing minimums, so any
// edit here can change what the dashboard and solver think a shift needs — hence every
// mutation also invalidates the dashboard summary, same as shift types and coverage above.
// ---------------------------------------------------------------------------

export function useAcuityTiers(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.acuityTiers(unitId ?? ''),
    queryFn: () => api.acuity.tiers(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateAcuityTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AcuityTierInput) => api.acuity.createTier(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: configKeys.acuityTiers(created.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(created.unitId) });
    },
  });
}

export function useUpdateAcuityTier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: AcuityTierPatch }) =>
      api.acuity.updateTier(id, patch),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.acuityTiers(updated.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(updated.unitId) });
    },
  });
}

export function useDeleteAcuityTier() {
  const queryClient = useQueryClient();
  return useMutation({
    // `acuity.deleteTier` returns void, so the unit id travels with the call, same pattern
    // as `useDeleteCoverage`/`useDeleteHoliday`.
    mutationFn: ({ id }: { id: Id; unitId: Id }) => api.acuity.deleteTier(id),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.acuityTiers(variables.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(variables.unitId) });
    },
  });
}

export function useRatioRules(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.ratioRules(unitId ?? ''),
    queryFn: () => api.acuity.ratioRules(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCreateRatioRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RatioRuleInput) => api.acuity.createRatioRule(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: configKeys.ratioRules(created.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(created.unitId) });
    },
  });
}

export function useUpdateRatioRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: RatioRulePatch }) =>
      api.acuity.updateRatioRule(id, patch),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.ratioRules(updated.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(updated.unitId) });
    },
  });
}

export function useDeactivateRatioRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.acuity.deactivateRatioRule(id),
    onSuccess: (deactivated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.ratioRules(deactivated.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(deactivated.unitId) });
    },
  });
}

export function useHppdTarget(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.hppd(unitId ?? ''),
    queryFn: () => api.acuity.hppd(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useSetHppdTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ unitId, targetHours }: { unitId: Id; targetHours: number }) =>
      api.acuity.setHppd(unitId, targetHours),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: configKeys.hppd(saved.unitId) });
      queryClient.invalidateQueries({ queryKey: dashboardKey(saved.unitId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Rule sets
//
// `rules.save` always inserts a new, immutable version (see the "Rule set versions are
// immutable" invariant in CLAUDE.md) — a published period snapshots the version it was solved
// under, so this hook never mutates the loaded rule set in place, only replaces the cache
// entry with whatever version the save call actually created.
// ---------------------------------------------------------------------------

export function useRuleSet(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.rules(unitId ?? ''),
    queryFn: () => api.rules.getLatest(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useSaveRuleSet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      unitId,
      name,
      configs,
      weekendDefinition,
      fairnessWeights,
    }: {
      unitId: Id;
      name: string;
      configs: RuleSet['configs'];
      weekendDefinition: RuleSet['weekendDefinition'];
      fairnessWeights: RuleSet['fairnessWeights'];
    }) => api.rules.save(unitId, name, configs, weekendDefinition, fairnessWeights),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: configKeys.rules(saved.unitId) });
    },
  });
}
