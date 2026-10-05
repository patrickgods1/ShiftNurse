/**
 * Day-of pay events: the missed breaks, send-homes and call-backs recorded from Today. They are
 * priced into the cost report's own section, so every write refreshes the whole `['cost',
 * 'report']` family (the hook is not told the period) as well as the events themselves.
 */

import type { DayOfPayEntry, DayOfPayPatch } from '@shared/api.js';
import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.js';

export const dayOfPayKeys = {
  list: (unitId: Id, start: IsoDate, end: IsoDate) =>
    ['dayOfPay', 'list', unitId, start, end] as const,
};

export function useDayOfPayEvents(unitId: Id | undefined, start: IsoDate, end: IsoDate) {
  return useQuery({
    queryKey: dayOfPayKeys.list(unitId ?? '', start, end),
    queryFn: () => api.dayOfPay.list(unitId as Id, start, end),
    enabled: unitId !== undefined,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['dayOfPay'] });
    void queryClient.invalidateQueries({ queryKey: ['cost', 'report'] });
  };
}

export function useRecordDayOfPay() {
  const invalidate = useInvalidate();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (entry: DayOfPayEntry) => api.dayOfPay.record(entry),
    onSuccess: invalidate,
  });
}

export function useUpdateDayOfPay() {
  const invalidate = useInvalidate();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ id, patch }: { id: Id; patch: DayOfPayPatch }) => api.dayOfPay.update(id, patch),
    onSuccess: invalidate,
  });
}

export function useRemoveDayOfPay() {
  const invalidate = useInvalidate();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (id: Id) => api.dayOfPay.remove(id),
    onSuccess: invalidate,
  });
}
