/**
 * Publish, change-log, output and backup hooks.
 *
 * Publishing changes more than the period row: the versions list, the change log, the
 * dashboard's "latest published", the fairness ledger (so the Fairness page's history and
 * trend), and the lookback tail every *other* period's validation reads. `usePublish`
 * therefore invalidates broadly rather than surgically — a stale "draft" badge after a
 * publish is exactly the kind of lie this screen must not tell.
 */

import type { Id } from '@shiftnurse/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OutputFormat } from '../../shared/api.js';
import { api, queryKeys } from './api.js';

export const publishKeys = {
  preview: (periodId: Id) => ['publish', 'preview', periodId] as const,
  versions: (periodId: Id) => ['publish', 'versions', periodId] as const,
  changes: (periodId: Id) => ['publish', 'changes', periodId] as const,
  alerts: (periodId: Id) => ['publish', 'alerts', periodId] as const,
  backups: () => ['backups'] as const,
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

export function usePublish(periodId: Id | undefined, unitId: Id | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (reason: string | undefined) => api.publish.publish(periodId as Id, reason),
    onSettled: () => {
      // Publication touches nearly every read model; a full invalidation is the honest one.
      void queryClient.invalidateQueries();
      if (unitId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.periods(unitId) });
      }
    },
  });
}

export function useExport(periodId: Id | undefined) {
  return useMutation({
    mutationFn: (format: OutputFormat) => api.output.exportToFile(periodId as Id, format),
  });
}

export function useBackups() {
  return useQuery({ queryKey: publishKeys.backups(), queryFn: () => api.backups.list() });
}

export function useCreateBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.backups.create(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: publishKeys.backups() }),
  });
}

export function useRestoreBackup() {
  return useMutation({ mutationFn: (fileName: string) => api.backups.restore(fileName) });
}
