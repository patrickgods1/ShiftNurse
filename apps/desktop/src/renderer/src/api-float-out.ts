/**
 * Float-out hooks, split out like `api-dayof.ts`. Floating takes a shift off the home schedule
 * the way a census cancellation does, so it refreshes through `afterAssignmentsChange`, which
 * covers the float queries and the day-of reads too.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FloatOrderRequest, FloatSendInput } from '../../shared/api.js';
import { api } from './api.js';
import { afterAssignmentsChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const floatOutKeys = {
  all: queryRoots.floatOut,
  order: (r: FloatOrderRequest) =>
    [
      ...queryRoots.floatOut,
      'order',
      r.periodId,
      r.date,
      r.shiftTypeId,
      r.role,
      [...r.volunteers],
    ] as const,
  history: (unitId: Id, since: IsoDate) =>
    [...queryRoots.floatOut, 'history', unitId, since] as const,
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

export function useFloatNurse(_unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: FloatSendInput) => api.floatOut.send(input),
    onSettled: () => afterAssignmentsChange(queryClient),
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
