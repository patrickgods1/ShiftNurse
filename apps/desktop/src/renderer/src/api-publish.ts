/**
 * Publish, change-log, output and backup hooks.
 *
 * Publishing changes more than the period row: the versions list, the change log, the
 * dashboard's "latest published", the fairness ledger (so the Fairness page's history and
 * trend), and the lookback tail every *other* period's validation reads. `usePublish`
 * therefore refreshes what any assignment write does (`afterAssignmentsChange`, every period)
 * plus those named lists — a stale "draft" badge after a publish is exactly the kind of lie this
 * screen must not tell, but refetching every query in the app (the settings tabs, the roster) is
 * noise.
 */

import type { Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutputFormat } from '../../shared/api.js';
import { api } from './api.js';
import { afterAssignmentsChange } from './period-cache.js';
import { queryRoots } from './query-roots.js';

export const publishKeys = {
  preview: (periodId: Id) => [...queryRoots.publishPreview, periodId] as const,
  versions: (periodId: Id) => [...queryRoots.publish, 'versions', periodId] as const,
  changes: (periodId: Id) => [...queryRoots.publishChanges, periodId] as const,
  alerts: (periodId: Id) => [...queryRoots.publishAlerts, periodId] as const,
  backups: () => [...queryRoots.backups] as const,
  // Under `backups()` so one prefix invalidation refreshes the list and the trash together.
  deletedBackups: () => [...queryRoots.backups, 'deleted'] as const,
};

export function usePublishPreview(periodId: Id | undefined, enabled = true) {
  return useQuery({
    queryKey: publishKeys.preview(periodId ?? ''),
    queryFn: () => api.publish.preview(periodId as Id),
    enabled: enabled && periodId !== undefined,
  });
}

export function useVersions(periodId: Id | undefined) {
  return useQuery({
    queryKey: publishKeys.versions(periodId ?? ''),
    queryFn: () => api.publish.versions(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useChanges(periodId: Id | undefined) {
  return useQuery({
    queryKey: publishKeys.changes(periodId ?? ''),
    queryFn: () => api.publish.changes(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function useAlerts(periodId: Id | undefined) {
  return useQuery({
    queryKey: publishKeys.alerts(periodId ?? ''),
    queryFn: () => api.publish.alerts(periodId as Id),
    enabled: periodId !== undefined,
  });
}

export function usePublish(periodId: Id | undefined, _unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: ({ reason, acknowledged }: { reason?: string; acknowledged: number }) =>
      api.publish.publish(periodId as Id, reason, acknowledged),
    onSettled: () => {
      // The lookback tail every other period's validation reads, and the dashboard.
      afterAssignmentsChange(queryClient);
      if (periodId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: publishKeys.versions(periodId) });
      }
      // Publishing takes a backup, flips the period's status, and writes the ledger that every
      // fairness report, the history and the trend read.
      for (const queryKey of [queryRoots.backups, queryRoots.periods, queryRoots.fairness]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * A caller that shows the failure beside its own control asks for `inlineError`; the default is
 * the toast, because the publish dialog's export buttons have nowhere else to put it.
 */
export function useExport(periodId: Id | undefined, options: { inlineError?: boolean } = {}) {
  return useMutation({
    ...(options.inlineError === true ? { meta: { inlineError: true } } : {}),
    mutationFn: (format: OutputFormat) => api.output.exportToFile(periodId as Id, format),
  });
}

export function useBackups() {
  return useQuery({ queryKey: publishKeys.backups(), queryFn: () => api.backups.list() });
}

export function useCreateBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: () => api.backups.create(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: publishKeys.backups() }),
  });
}

export function useRestoreBackup() {
  return useMutation({
    meta: { inlineError: true },
    mutationFn: (fileName: string) => api.backups.restore(fileName),
  });
}

export function useDeletedBackups() {
  return useQuery({
    queryKey: publishKeys.deletedBackups(),
    queryFn: () => api.backups.listDeleted(),
  });
}

/** Every trash operation moves a file between the list and the trash, so refresh both. */
function useBackupFileMutation<T>(mutationFn: (vars: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: publishKeys.backups() }),
  });
}

export function useDeleteBackup() {
  return useBackupFileMutation(
    async ({ fileName, permanent }: { fileName: string; permanent: boolean }) =>
      api.backups.remove(fileName, { permanent }),
  );
}

export function useUndeleteBackup() {
  return useBackupFileMutation(async (fileName: string) => api.backups.undelete(fileName));
}

export function usePurgeBackup() {
  return useBackupFileMutation(async (fileName: string) => api.backups.purge(fileName));
}
