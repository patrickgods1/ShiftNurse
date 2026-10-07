/**
 * Float-out hooks, split out like `api-dayof.ts`. Floating takes a shift off the home schedule
 * the way a census cancellation does, so besides the float queries it invalidates the period
 * family and the day-of reads.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FloatOrderRequest, FloatSendInput } from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { invalidatePeriod } from './period-cache.js';

export const floatOutKeys = {
  all: ['floatOut'] as const,
  order: (r: FloatOrderRequest) =>
    ['floatOut', 'order', r.periodId, r.date, r.shiftTypeId, r.role, [...r.volunteers]] as const,
  history: (unitId: Id, since: IsoDate) => ['floatOut', 'history', unitId, since] as const,
};

export function useFloatOrder(request: FloatOrderRequest | undefined) {
  return useQuery({
    queryKey: floatOutKeys.order(
      request ?? { periodId: '', date: '' as IsoDate, shiftTypeId: '', role: 'RN', volunteers: [] },
    ),
    queryFn: () => api.floatOut.order(request as FloatOrderRequest),
    enabled: request !== undefined,
  });
}

export function useFloatHistory(unitId: Id | undefined, since: IsoDate) {
  return useQuery({
    queryKey: floatOutKeys.history(unitId ?? '', since),
    queryFn: () => api.floatOut.history(unitId as Id, since),
    enabled: unitId !== undefined,
  });
}

export function useFloatNurse(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: FloatSendInput) => api.floatOut.send(input),
    onSuccess: (_record, input) => invalidatePeriod(queryClient, input.periodId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['dayOf'] });
      void queryClient.invalidateQueries({ queryKey: floatOutKeys.all });
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
      }
    },
  });
}

export function useRecordFloatObjection() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, objection }: { id: Id; objection: string }) =>
      api.floatOut.recordObjection(id, objection),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: floatOutKeys.all }),
  });
}
