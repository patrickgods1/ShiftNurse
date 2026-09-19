/**
 * Schedule-grid data hooks: live rule validation for a period, and the mutations that create,
 * move, edit, lock and delete assignments.
 *
 * Every mutation invalidates the same four things — that period's assignments, its validation,
 * its cost report, and the unit's dashboard summary (which shows the current draft) — because
 * a schedule edit without a validation refresh is exactly the failure mode the milestone brief
 * calls out: the grid would keep showing a stale "no violations" state for a shift that just
 * became illegal, and a stale price for a shift that just became overtime.
 * Invalidation runs in `onSettled`, not `onSuccess`, so a failed mutation still forces the grid
 * back to the server's truth instead of leaving an optimistic chip stranded.
 */

import type { Id, IsoDate } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AssignmentPatch,
  CreateAssignmentInput,
  MoveAssignmentInput,
} from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { costKeys } from './api-cost.js';

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
    if (periodId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(periodId) });
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.validation(periodId) });
      void queryClient.invalidateQueries({ queryKey: costKeys.report(periodId) });
    }
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  };
}

export function useCreateAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: (input: CreateAssignmentInput) => api.schedule.createAssignment(input),
    onSettled: invalidate,
  });
}

export function useMoveAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: (input: MoveAssignmentInput) => api.schedule.moveAssignment(input),
    onSettled: invalidate,
  });
}

export function useUpdateAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: ({ assignmentId, patch }: { assignmentId: Id; patch: AssignmentPatch }) =>
      api.schedule.updateAssignment(assignmentId, patch),
    onSettled: invalidate,
  });
}

export function useDeleteAssignment(periodId: Id | undefined, unitId: Id | undefined) {
  const invalidate = useInvalidateSchedule(periodId, unitId);
  return useMutation({
    mutationFn: (assignmentId: Id) => api.schedule.deleteAssignment(assignmentId),
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
