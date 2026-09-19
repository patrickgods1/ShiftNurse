/**
 * Generate-flow hooks: start a solve, poll its status while it runs, cancel it.
 *
 * A solve is a job, not a query: `start` returns at once and the result arrives later. The
 * status query polls while the job is running and stops on its own once it settles, and the
 * moment it settles as `done` every read the schedule page depends on — assignments,
 * validation, cost, fairness, the dashboard's draft summary — is invalidated, because the main
 * process has just rewritten the period underneath them.
 */

import type { Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { SolveJobOptions, SolveJobStatus } from '../../shared/api.js';
import { api, queryKeys } from './api.js';
import { costKeys } from './api-cost.js';
import { fairnessQueryKeys } from './api-fairness.js';
import { scheduleKeys } from './api-schedule.js';

export const solverKeys = {
  job: (jobId: Id) => ['solver', 'job', jobId] as const,
};

const POLL_MS = 250;

export function isSettled(status: SolveJobStatus | undefined): boolean {
  return status !== undefined && status.state !== 'running' && status.state !== 'applying';
}

export function useStartSolve() {
  return useMutation({
    mutationFn: ({ periodId, options }: { periodId: Id; options?: SolveJobOptions }) =>
      api.solver.start(periodId, options),
  });
}

export function useCancelSolve() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: Id) => api.solver.cancel(jobId),
    onSuccess: (status) => {
      if (status) queryClient.setQueryData(solverKeys.job(status.id), status);
    },
  });
}

/** Poll a job until it settles, then refresh everything the schedule page reads. */
export function useSolveJob(
  jobId: Id | undefined,
  periodId: Id | undefined,
  unitId: Id | undefined,
) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: solverKeys.job(jobId ?? ''),
    queryFn: () => api.solver.status(jobId as Id),
    enabled: jobId !== undefined,
    refetchInterval: (q) => (isSettled(q.state.data) ? false : POLL_MS),
  });

  // Invalidate exactly once per finished job, not on every re-render that sees `done`.
  const invalidatedFor = useRef<Id | undefined>(undefined);
  const status = query.data;
  useEffect(() => {
    if (status?.state !== 'done' || invalidatedFor.current === status.id) return;
    invalidatedFor.current = status.id;
    if (periodId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(periodId) });
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.validation(periodId) });
      void queryClient.invalidateQueries({ queryKey: costKeys.report(periodId) });
      void queryClient.invalidateQueries({ queryKey: fairnessQueryKeys.report(periodId) });
    }
    if (unitId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(unitId) });
    }
  }, [status, periodId, unitId, queryClient]);

  return query;
}
