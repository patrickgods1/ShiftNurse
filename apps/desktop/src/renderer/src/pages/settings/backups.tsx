/**
 * Settings › Backups: the list of copies the app has kept, a button to take one now, and the
 * one-click restore. Restore is the destructive action on this screen — it replaces the live
 * database and relaunches — so it asks for confirmation naming the file, and says up front
 * that the current state is saved as a `pre-restore` backup first (which makes a wrong
 * restore itself reversible from this same list).
 */

import type { BackupInfo } from '@shared/api.js';
import { useState } from 'react';
import { useBackups, useCreateBackup, useRestoreBackup } from '../../api-publish.js';
import { AsyncState } from '../../components/async-state.js';
import { DANGER, errorMessage, PRIMARY, SMALL } from '../requests/ui.js';

const KIND_LABEL: Record<string, string> = {
  publish: 'On publish',
  daily: 'Daily',
  manual: 'Manual',
  'pre-restore': 'Before restore',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackupsPanel() {
  const backupsQuery = useBackups();
  const createBackup = useCreateBackup();
  const restore = useRestoreBackup();
  const [confirming, setConfirming] = useState<BackupInfo | undefined>(undefined);

  return (
    <section className="rounded-md border border-border bg-surface p-4" data-testid="backups-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">Backups</h2>
          <p className="text-xs text-text-muted">
            A copy is written every time a schedule is published, once a day on launch (the last 14
            are kept), and whenever you ask for one here.
          </p>
        </div>
        <button
          type="button"
          className={PRIMARY}
          disabled={createBackup.isPending}
          onClick={() => createBackup.mutate()}
        >
          {createBackup.isPending ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {createBackup.isError ? (
        <p role="alert" className="mb-2 text-sm text-danger">
          {errorMessage(createBackup.error)}
        </p>
      ) : null}

      {backupsQuery.isPending ? (
        <AsyncState status="loading" label="Loading backups" />
      ) : backupsQuery.isError ? (
        <AsyncState status="error" label="Could not list backups" error={backupsQuery.error} />
      ) : backupsQuery.data.length === 0 ? (
        <AsyncState status="empty" label="No backups yet." />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">When</th>
              <th className="py-1 pr-3 font-medium">Kind</th>
              <th className="py-1 pr-3 font-medium">File</th>
              <th className="py-1 pr-3 font-medium">Size</th>
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {backupsQuery.data.map((b) => (
              <tr key={b.fileName} className="border-t border-border">
                <td className="py-1.5 pr-3 text-text">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="py-1.5 pr-3 text-text-muted">{KIND_LABEL[b.kind] ?? b.kind}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-text-muted" title={b.path}>
                  {b.fileName}
                </td>
                <td className="py-1.5 pr-3 text-text-muted">{formatBytes(b.bytes)}</td>
                <td className="py-1.5 text-right">
                  <button
                    type="button"
                    className={SMALL}
                    disabled={restore.isPending}
                    onClick={() => setConfirming(b)}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirming !== undefined ? (
        <div
          role="alertdialog"
          aria-label="Confirm restore"
          className="mt-4 rounded-md border border-danger/50 bg-bg p-3 text-sm"
        >
          <p className="text-text">
            Restore <span className="font-mono text-xs">{confirming.fileName}</span>? The current
            database is saved first as a “before restore” backup, then the app restarts on the
            restored copy. Anything entered since that backup will be in the saved copy, not the
            live one.
          </p>
          {restore.isError ? (
            <p role="alert" className="mt-2 text-danger">
              {errorMessage(restore.error)}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className={SMALL}
              disabled={restore.isPending}
              onClick={() => setConfirming(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={DANGER}
              disabled={restore.isPending}
              onClick={() => restore.mutate(confirming.fileName)}
            >
              {restore.isPending ? 'Restoring — restarting…' : 'Restore and restart'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
