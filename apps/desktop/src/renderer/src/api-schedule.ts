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
    mutationFn: ({ reason, ...input }: CreateAssignmentInput & WithReason) =>
      api.schedule.createAssignment(input, reason),
    onSettled: invalidate,
  });
}

export function useMoveAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: ({ reason, ...input }: MoveAssignmentInput & WithReason) =>
      api.schedule.moveAssignment(input, reason),
    onSettled: invalidate,
  });
}

export function useUpdateAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
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
    mutationFn: ({ assignmentId, reason }: { assignmentId: Id } & WithReason) =>
      api.schedule.deleteAssignment(assignmentId, reason),
    onSettled: invalidate,
  });
}

export function useSetLocked(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: ({ assignmentId, locked }: { assignmentId: Id; locked: boolean }) =>
      api.schedule.setLocked(assignmentId, locked),
    onSettled: invalidate,
  });
}

export function useCreatePeriod(unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; startDate: IsoDate; endDate: IsoDate }) =>
      api.periods.create({ unitId: unitId as Id, ...input }),
    onSuccess: () => {
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.periods(unitId) });
      }
    },
  });
}
