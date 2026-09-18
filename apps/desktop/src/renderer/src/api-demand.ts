/**
 * Census/demand query keys and hooks, split out from `api.ts` so this page's data layer can be
 * built without touching the file another agent is editing concurrently. Follows the same
 * pattern: `api` is the single IPC surface, hooks own their query keys, mutations invalidate the
 * census/demand caches for the affected unit+range rather than the whole app.
 */

import type { AcuityTier, CensusForecast, ForecastOptions, Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CensusForecastInput } from '../../shared/api.js';
import { api } from './api.js';

export const demandQueryKeys = {
  acuityTiers: (unitId: Id) => ['acuity', 'tiers', unitId] as const,
  census: (unitId: Id, start: IsoDate, end: IsoDate) => ['census', unitId, start, end] as const,
  demand: (unitId: Id, start: IsoDate, end: IsoDate) => ['demand', unitId, start, end] as const,
  backtest: (unitId: Id, options: ForecastOptions | undefined) =>
    ['backtest', unitId, options ?? {}] as const,
};

export function useAcuityTiers(unitId: Id | undefined) {
  return useQuery({
    queryKey: demandQueryKeys.acuityTiers(unitId ?? ''),
    queryFn: () => api.acuity.tiers(unitId as Id),
    enabled: unitId !== undefined,
  });
}

export function useCensus(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  return useQuery({
    queryKey: demandQueryKeys.census(unitId ?? '', start, end),
    queryFn: () => api.census.list(unitId as Id, start, end),
    enabled: unitId !== undefined,
  });
}

export function useDemand(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  return useQuery({
    queryKey: demandQueryKeys.demand(unitId ?? '', start, end),
    queryFn: () => api.census.demand(unitId as Id, start, end),
    enabled: unitId !== undefined,
  });
}

export function useBacktest(unitId: Id | undefined, options: ForecastOptions | undefined) {
  return useQuery({
    queryKey: demandQueryKeys.backtest(unitId ?? '', options),
    queryFn: () => api.census.backtest(unitId as Id, options),
    enabled: unitId !== undefined,
  });
}

/**
 * Every write below invalidates census *and* demand for the same range — demand is derived
 * from census, so a stale demand table would show a binding constraint that no longer matches
 * what the manager just typed.
 */
function useInvalidateCensus(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  const queryClient = useQueryClient();
  return () => {
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: demandQueryKeys.census(unitId, start, end) });
      void queryClient.invalidateQueries({ queryKey: demandQueryKeys.demand(unitId, start, end) });
    }
  };
}

export function useUpsertCensus(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  const invalidate = useInvalidateCensus(unitId, start, end);
  return useMutation({
    mutationFn: (input: CensusForecastInput) => api.census.upsert(input),
    onSuccess: invalidate,
  });
}

export function useUpsertManyCensus(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  const invalidate = useInvalidateCensus(unitId, start, end);
  return useMutation({
    mutationFn: (inputs: CensusForecastInput[]) => api.census.upsertMany(inputs),
    onSuccess: invalidate,
  });
}

export function useRecordActualCensus(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  const invalidate = useInvalidateCensus(unitId, start, end);
  return useMutation({
    mutationFn: ({
      id,
      actualCensus,
      actualAcuityMix,
    }: {
      id: Id;
      actualCensus: number;
      actualAcuityMix: Record<Id, number>;
    }) => api.census.recordActual(id, actualCensus, actualAcuityMix),
    onSuccess: invalidate,
  });
}

export function useProposeCensus(unitId: Id | undefined) {
  return useMutation({
    mutationFn: ({
      start,
      end,
      options,
    }: {
      start: IsoDate;
      end: IsoDate;
      options?: ForecastOptions;
    }) => api.census.propose(unitId as Id, start, end, options),
  });
}

/** Looks up an existing forecast row for a date/shift, so the grid can render "—" or a value. */
export function findCensus(
  rows: readonly CensusForecast[] | undefined,
  date: IsoDate,
  shiftTypeId: Id,
): CensusForecast | undefined {
  return rows?.find((r) => r.date === date && r.shiftTypeId === shiftTypeId);
}

/** Sums an acuity mix, used to validate against a projected/actual census before saving. */
export function sumMix(mix: Record<Id, number>): number {
  return Object.values(mix).reduce((a, b) => a + b, 0);
}

export function tierNameLookup(tiers: readonly AcuityTier[] | undefined): Map<Id, string> {
  return new Map((tiers ?? []).map((t) => [t.id, t.name]));
}
