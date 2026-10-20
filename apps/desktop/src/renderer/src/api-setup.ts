/**
 * Hooks for first-run setup and the unit's own details.
 *
 * Every setup mutation invalidates the whole cache: loading the demo or applying a preset
 * writes across shift types, floors, tiers, holidays and pay at once, and one stale editor
 * embedded in the guide would show "no shift types" beside the ones just added.
 */

import type { UnitInput, UnitPatch } from '@shared/api.js';
import type {
  Id,
  JurisdictionChoices,
  JurisdictionId,
  SetupPreset,
  SetupStepId,
  UnitSetupMode,
} from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';
import { refreshEverything } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const setupKeys = {
  status: () => [...queryRoots.setup, 'status'] as const,
  demos: () => [...queryRoots.setup, 'demos'] as const,
};

export function useSetupStatus() {
  return useQuery({ queryKey: setupKeys.status(), queryFn: () => api.setup.status() });
}

export function useDemos() {
  return useQuery({
    queryKey: setupKeys.demos(),
    queryFn: () => api.setup.demos(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLoadDemo() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (demoId: string) => api.setup.loadDemo(demoId),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useLoadScenarios() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.setup.loadScenarios(),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useCreateSetupUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (vars: { input: UnitInput; mode: UnitSetupMode }) =>
      api.setup.createUnit(vars.input, vars.mode),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useAdvanceSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (move: { from: SetupStepId; to: SetupStepId; skipped: boolean }) =>
      api.setup.advance(move),
    // Returned, so the mutation stays pending until the next step has arrived and a quick
    // second Continue cannot send a second move.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: setupKeys.status() }),
  });
}

export function useCompleteSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.setup.complete(),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useResumeSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.setup.resume(),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useApplyPreset(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (preset: SetupPreset) => api.setup.applyPreset(unitId, preset),
    onSuccess: () => refreshEverything(queryClient),
  });
}

/** Writes ratio rules, overtime rules and rule versions, so everything is refetched. */
export function useApplyJurisdiction(unitId: Id) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      jurisdiction,
      choices,
    }: {
      jurisdiction: JurisdictionId;
      choices?: JurisdictionChoices;
    }) => api.setup.applyJurisdiction(unitId, jurisdiction, choices),
    onSuccess: () => refreshEverything(queryClient),
  });
}

/** Resolves just before the app relaunches; nothing to invalidate. */
export function useStartOver() {
  return useMutation({ meta: { inlineError: true }, mutationFn: () => api.setup.startOver() });
}

export function useUpdateUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (vars: { id: Id; patch: UnitPatch }) => api.units.update(vars.id, vars.patch),
    onSuccess: () => refreshEverything(queryClient),
  });
}
