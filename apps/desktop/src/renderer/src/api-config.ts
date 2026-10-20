/**
 * Query keys, queries and mutations for the unit-configuration screens (shift-type writes,
 * coverage floors, holidays, acuity, rules). Split from `api.ts` by screen so each page's data
 * layer reads in one file. This module owns every configuration key; other modules import from
 * it. Each write refreshes its own list, then `afterConfigChange` reaches everything those
 * settings judge or price (the dashboard included).
 */

import type { Id, RuleSet } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcuityTierInput,
  AcuityTierPatch,
  CoverageRequirementInput,
  CoverageWeekInput,
  HolidayInput,
  HolidayPatch,
  HolidayYearInput,
  RatioRuleInput,
  RatioRulePatch,
  ShiftTypeDuplicateChanges,
  ShiftTypeInput,
  ShiftTypePatch,
} from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { afterConfigChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const configKeys = {
  coverage: (unitId: Id) => [...queryRoots.coverage, unitId] as const,
  holidays: (unitId: Id) => [...queryRoots.holidays, unitId] as const,
  holidayWork: (holidayId: Id) => [...queryRoots.holidayWork, holidayId] as const,
  holidayYearPlan: (unitId: Id, year: number) =>
    [...queryRoots.holidayYearPlan, unitId, year] as const,
  acuityTiers: (unitId: Id) => [...queryRoots.acuityTiers, unitId] as const,
  ratioRules: (unitId: Id) => [...queryRoots.ratioRules, unitId] as const,
  hppdTarget: (unitId: Id) => [...queryRoots.hppdTarget, unitId] as const,
  rules: (unitId: Id) => [...queryRoots.rules, unitId] as const,
};

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

export function useCreateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: ShiftTypeInput) => api.shiftTypes.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shiftTypes(created.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

export function useUpdateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: ShiftTypePatch }) =>
      api.shiftTypes.update(id, patch),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shiftTypes(updated.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

/** Shift types a published or archived schedule used; main decides, the screen only reads. */
export function useLockedShiftTypeIds(unitId: Id | undefined) {
  return useQuery({
    queryKey: [...queryKeys.shiftTypes(unitId ?? ''), 'locked'] as const,
    queryFn: () => api.shiftTypes.lockedIds(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useDuplicateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, changes }: { id: Id; changes: ShiftTypeDuplicateChanges }) =>
      api.shiftTypes.duplicate(id, changes),
    onSuccess: (result) => {
      // The shift-type root covers the list and the locked ids; a duplicate also moves floors,
      // credential requirements, future forecasts and wishes onto the new type.
      queryClient.invalidateQueries({ queryKey: queryKeys.shiftTypes(result.shiftType.unitId) });
      for (const queryKey of [
        queryRoots.coverage,
        queryRoots.credentials,
        queryRoots.census,
        queryRoots.preferences,
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
      afterConfigChange(queryClient);
    },
  });
}

export function useDeactivateShiftType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.shiftTypes.deactivate(id),
    onSuccess: (deactivated) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.shiftTypes(deactivated.unitId) });
      afterConfigChange(queryClient);
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
      afterConfigChange(queryClient);
    },
  });
}

export function useFillCoverageWeek() {
  const queryClient = useQueryClient();
  return useMutation({
    // The button shows the refusal beside itself; the global toast would say it twice.
    meta: { inlineError: true },
    mutationFn: (input: CoverageWeekInput) => api.coverage.fillWeek(input),
    // onSettled, not onSuccess: a refusal still refetches, so the grid shows what is really saved.
    onSettled: (_rows, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.coverage(variables.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

export function useDeleteCoverage() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    // `coverage.delete` returns void, so the unit id has to travel with the call for
    // cache invalidation — the caller always has it (it's reading the unit's own grid).
    mutationFn: ({ id }: { id: Id; unitId: Id }) => api.coverage.delete(id),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.coverage(variables.unitId) });
      afterConfigChange(queryClient);
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
    meta: { inlineError: true },
    mutationFn: (input: HolidayInput) => api.holidays.create(input),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: configKeys.holidays(created.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

/** Rename, move between major and minor, pair, or re-date. Unpairing minors changes other rows too. */
export function useUpdateHoliday() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      id,
      patch,
      reason,
    }: {
      id: Id;
      unitId: Id;
      patch: HolidayPatch;
      reason?: string;
    }) =>
      // Absent, not undefined: the bridge call records its arguments.
      reason === undefined
        ? api.holidays.update(id, patch)
        : api.holidays.update(id, patch, reason),
    onSuccess: (_updated, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.holidays(variables.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

export function useHolidayWork(holidayId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.holidayWork(holidayId ?? ''),
    queryFn: () => api.holidays.work(holidayId as Id),
    enabled: holidayId !== undefined,
    // Published schedules change it too; it is one small read, so always ask again.
    staleTime: 0,
  });
}

export function useRecordHolidayWork() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ holidayId, nurseIds }: { holidayId: Id; nurseIds: Id[] }) =>
      api.holidays.recordWork(holidayId, nurseIds),
    onSuccess: (summary) => {
      queryClient.setQueryData(configKeys.holidayWork(summary.holidayId), summary);
      afterConfigChange(queryClient);
    },
  });
}

export function useClearHolidayWork() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (holidayId: Id) => api.holidays.clearWork(holidayId),
    onSuccess: (summary) => {
      queryClient.setQueryData(configKeys.holidayWork(summary.holidayId), summary);
      afterConfigChange(queryClient);
    },
  });
}

/** A proposal for a year of holidays; nothing is saved by asking. */
export function useHolidayYearPlan(unitId: Id | undefined, year: number | undefined) {
  return useQuery({
    queryKey: configKeys.holidayYearPlan(unitId ?? '', year ?? 0),
    queryFn: () => api.holidays.planYear(unitId as Id, year as number),
    enabled: unitId !== undefined && year !== undefined,
    staleTime: 0,
  });
}

export function useAddHolidayYear() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ unitId, input }: { unitId: Id; input: HolidayYearInput }) =>
      api.holidays.addYear(unitId, input),
    onSuccess: (_added, variables) => {
      queryClient.invalidateQueries({ queryKey: configKeys.holidays(variables.unitId) });
      afterConfigChange(queryClient);
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
      afterConfigChange(queryClient);
    },
  });
}

// ---------------------------------------------------------------------------
// Acuity tiers, ratio rules and the HPPD target
//
// All three feed `acuity/demand.ts`'s derivation of per-shift staffing minimums, so any
// edit here can change what the dashboard and solver think a shift needs — hence every
// mutation refreshes the dashboard summary through `afterConfigChange`, same as shift types
// and coverage above.
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
      afterConfigChange(queryClient);
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
      afterConfigChange(queryClient);
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
      afterConfigChange(queryClient);
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
      afterConfigChange(queryClient);
    },
  });
}

export function useUpdateRatioRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, reason }: { id: Id; patch: RatioRulePatch; reason?: string }) =>
      api.acuity.updateRatioRule(id, patch, reason),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.ratioRules(updated.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

export function useDeactivateRatioRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: Id; reason: string }) =>
      api.acuity.deactivateRatioRule(id, reason),
    onSuccess: (deactivated) => {
      queryClient.invalidateQueries({ queryKey: configKeys.ratioRules(deactivated.unitId) });
      afterConfigChange(queryClient);
    },
  });
}

export function useHppdTarget(unitId: Id | undefined) {
  return useQuery({
    queryKey: configKeys.hppdTarget(unitId ?? ''),
    queryFn: async () => (await api.acuity.hppd(unitId as Id)) ?? null,
    enabled: unitId !== undefined,
  });
}

export function useSetHppdTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ unitId, targetHours }: { unitId: Id; targetHours: number }) =>
      api.acuity.setHppd(unitId, targetHours),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: configKeys.hppdTarget(saved.unitId) });
      afterConfigChange(queryClient);
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
    meta: { inlineError: true },
    mutationFn: ({
      unitId,
      name,
      configs,
      weekendDefinition,
      fairnessWeights,
      reason,
    }: {
      unitId: Id;
      name: string;
      configs: RuleSet['configs'];
      weekendDefinition: RuleSet['weekendDefinition'];
      fairnessWeights: RuleSet['fairnessWeights'];
      reason?: string;
    }) => api.rules.save(unitId, name, configs, weekendDefinition, fairnessWeights, reason),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: configKeys.rules(saved.unitId) });
      afterConfigChange(queryClient);
    },
  });
}
