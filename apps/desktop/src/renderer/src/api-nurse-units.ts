/**
 * The float pool. A membership changes more than its own list: the grid's rows (the nurse is on
 * or off this unit's roster), every period's validation (their other unit's shifts count against
 * rest here) and what Generate may use. So a write refreshes everything rather than guessing
 * which of those the open screen shows.
 */

import type { NurseUnitInput, NurseUnitPatch } from '@shared/api.js';
import type { Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from './api.js';
import { refreshEverything } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const nurseUnitKeys = {
  forNurse: (nurseId: Id) => [...queryRoots.nurseUnits, 'forNurse', nurseId] as const,
  floatingIn: (unitId: Id) => [...queryRoots.nurseUnits, 'floatingIn', unitId] as const,
  // These two sit under the unit's nurse key, so every roster edit that refreshes the nurses
  // refreshes the grid's rows too.
  gridNurses: (unitId: Id) => [...queryKeys.nurses(unitId), 'withFloats'] as const,
  periodRoster: (unitId: Id, periodId: Id) =>
    [...queryKeys.nurses(unitId), 'roster', periodId] as const,
};

export function useNurseUnits(nurseId: Id | undefined) {
  return useQuery({
    queryKey: nurseUnitKeys.forNurse(nurseId ?? ''),
    queryFn: () => api.nurseUnits.forNurse(nurseId as Id),
    enabled: nurseId !== undefined,
  });
}

/** Nurses from other units who may work on this one: the grid shows them beside the home roster. */
export function useFloatingIn(unitId: Id | undefined) {
  return useQuery({
    queryKey: nurseUnitKeys.floatingIn(unitId ?? ''),
    queryFn: () => api.nurseUnits.floatingIn(unitId as Id),
    enabled: unitId !== undefined,
  });
}

/**
 * The unit's own nurses and then those floated in, as the grid's rows and names. One query rather
 * than two so a caller's loading and error states stay one test; it sits under `queryKeys.nurses`
 * so every roster edit refreshes it too.
 */
export function useGridNurses(unitId: Id | undefined) {
  return useQuery({
    queryKey: nurseUnitKeys.gridNurses(unitId ?? ''),
    queryFn: async () => [
      ...(await api.nurses.list(unitId as Id)),
      ...(await api.nurseUnits.floatingIn(unitId as Id)),
    ],
    enabled: unitId !== undefined,
  });
}

/**
 * Who a period's schedule may hold, as the grid's rows: the home roster, then floats whose
 * membership touches the period. The same definition validation and Generate read, so the grid
 * never offers a nurse the period cannot judge.
 */
export function usePeriodRoster(unitId: Id | undefined, periodId: Id | undefined) {
  return useQuery({
    queryKey: nurseUnitKeys.periodRoster(unitId ?? '', periodId ?? ''),
    queryFn: () => api.nurseUnits.roster(periodId as Id),
    enabled: unitId !== undefined && periodId !== undefined,
  });
}

export function useAddNurseUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: NurseUnitInput) => api.nurseUnits.create(input),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useUpdateNurseUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: NurseUnitPatch }) =>
      api.nurseUnits.update(id, patch),
    onSuccess: () => refreshEverything(queryClient),
  });
}

export function useRemoveNurseUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.nurseUnits.remove(id),
    onSuccess: () => refreshEverything(queryClient),
  });
}
