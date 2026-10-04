/**
 * Schedule-grid data hooks: live rule validation for a period, and the mutations that create,
 * move, edit, lock and delete assignments.
 *
 * Every mutation refreshes the period's derived views (`invalidatePeriod`: assignments,
 * validation, cost, fairness, conflicts, publish preview/alerts) and the unit's dashboard, because
 * a schedule edit without a validation refresh is exactly the failure mode the milestone brief
 * calls out: the grid would keep showing a stale "no violations" state for a shift that just
 * became illegal, and a stale price for a shift that just became overtime.
 * Invalidation runs in `onSettled`, not `onSuccess`, so a failed mutation still forces the grid
 * back to the server's truth instead of leaving an optimistic chip stranded.
 *
 * Every mutation carries an optional `reason`. On a published period main refuses the edit
 * without one and writes it to the change log; on a draft it is ignored. The board collects it
 * through a dialog before calling these, so the hooks stay reason-agnostic.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignmentPatch,
  CreateAssignmentInput,
  MoveAssignmentInput,
} from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { invalidatePeriod } from './period-cache.js';

export interface WithReason {
  reason?: string;
}

export const scheduleKeys = {
  validation: (periodId: Id) => ['validation', periodId] as const,
};

export function useValidation(periodId: Id | undefined) {
  return useQuery({
    queryKey: scheduleKeys.validation(periodId ?? ''),
    queryFn: () => api.schedule.validate(periodId as Id),
    enabled: periodId !== undefined,
  });
}

function useInvalidateSchedule(periodId: Id | undefined, unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (periodId !== undefined) invalidatePeriod(queryClient, periodId);
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  };
}

export function useCreateAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ reason, ...input }: CreateAssignmentInput & WithReason) =>
      api.schedule.createAssignment(input, reason),
    onSettled: invalidate,
  });
}

export function useMoveAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ reason, ...input }: MoveAssignmentInput & WithReason) =>
      api.schedule.moveAssignment(input, reason),
    onSettled: invalidate,
  });
}

/** Two nurses trade shifts in one step (main runs both moves in one transaction). */
export function useSwapAssignments(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ firstId, secondId, reason }: { firstId: Id; secondId: Id } & WithReason) =>
      api.schedule.swapAssignments(firstId, secondId, reason),
    onSettled: invalidate,
  });
}

export function useUpdateAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({
      assignmentId,
      patch,
      reason,
    }: { assignmentId: Id; patch: AssignmentPatch } & WithReason) =>
      api.schedule.updateAssignment(assignmentId, patch, reason),
    onSettled: invalidate,
  });
}

export function useDeleteAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ assignmentId, reason }: { assignmentId: Id } & WithReason) =>
      api.schedule.deleteAssignment(assignmentId, reason),
    onSettled: invalidate,
  });
}

export function useSetLocked(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ assignmentId, locked }: { assignmentId: Id; locked: boolean }) =>
      api.schedule.setLocked(assignmentId, locked),
    onSettled: invalidate,
  });
}

/** Set or clear when time-off requests close for a period. */
export function useSetRequestsCloseOn(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ periodId, date }: { periodId: Id; date: IsoDate | null }) =>
      api.periods.setRequestsCloseOn(periodId, date),
    onSuccess: () => {
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.periods(unitId) });
      }
    },
  });
}

export function useCreatePeriod(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (input: {
      name: string;
      startDate: IsoDate;
      endDate: IsoDate;
      requestsCloseOn?: IsoDate;
    }) => api.periods.create({ unitId: unitId as Id, ...input }),
    onSuccess: () => {
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.periods(unitId) });
      }
    },
  });
}
