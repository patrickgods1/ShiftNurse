/**
 * Settings › Backups: the list of copies the app has kept, a button to take one now, and the
 * one-click restore. Restore is the destructive action on this screen — it replaces the live
 * database and relaunches — so it asks for confirmation naming the file, and says up front
 * that the current state is saved as a `pre-restore` backup first (which makes a wrong
 * restore itself reversible from this same list).
 *
 * The prompts are `Modal`s: with 14 daily copies plus publish copies an inline block under the
 * table was off-screen for the top rows, and an alertdialog must take focus.
 *
 * Delete is soft: a deleted backup waits under "Deleted backups" for 30 days, where it can be
 * put back or deleted permanently, and the next launch after that purges it. Permanent
 * deletion is offered in the same confirmation as the trash, never as a one-click row action.
 */

import type { BackupInfo, DeletedBackupInfo } from '@shared/api.js';
import { type ReactNode, useRef, useState } from 'react';
import {
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useDeletedBackups,
  usePurgeBackup,
  useRestoreBackup,
  useUndeleteBackup,
} from '../../api-publish.js';
import { AsyncState } from '../../components/async-state.js';
import { Modal } from '../../components/modal.js';
import {
  DANGER_SOLID,
  errorMessage,
  PRIMARY,
  SECONDARY,
  SMALL,
  SMALL_DANGER,
} from '../../components/ui.js';
import { formatInstant } from '../../format.js';

const KIND_LABEL: Record<string, string> = {
  publish: 'On publish',
  daily: 'Daily',
  manual: 'Manual',
  'pre-restore': 'Before restore',
  'pre-reset': 'Before start over',
  'pre-migrate': 'Before update',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One shape for the three prompts. While `pending` the dialog cannot be dismissed: a restore that
 * has started is relaunching the app, and closing the prompt over it would hide the outcome.
 * The last question is kept so the dialog's content does not blank while it closes.
 */
function ConfirmBackup({
  open,
  title,
  pending,
  onClose,
  returnFocus,
  footer,
  children,
}: {
  open: boolean;
  title: string;
  pending: boolean;
  onClose(): void;
  returnFocus?: () => HTMLElement | null | undefined;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      onEscapeKeyDown={(event) => pending && event.preventDefault()}
      onInteractOutside={(event) => pending && event.preventDefault()}
      variant="popup"
      size="md"
      role="alertdialog"
      title={title}
      {...(returnFocus ? { returnFocus } : {})}
      footer={footer}
    >
      <div className="mt-2 text-sm">{children}</div>
    </Modal>
  );
}

/** Keeps the last non-undefined value, so a closing dialog still has its text. */
function useLastShown<T>(value: T | undefined): T | undefined {
  const last = useRef<T | undefined>(value);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}

export default function BackupsPanel() {
  const backupsQuery = useBackups();
  const createBackup = useCreateBackup();
  const restore = useRestoreBackup();
  const deleteBackup = useDeleteBackup();
  const [confirming, setConfirming] = useState<BackupInfo | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState<BackupInfo | undefined>(undefined);
  const backUpNow = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restoring = useLastShown(confirming);
  const deleting = useLastShown(confirmingDelete);
  // The list can re-render under an open prompt (a daily copy lands); the row's button may be gone.
  const returnFocus = () => (opener.current?.isConnected ? opener.current : backUpNow.current);

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
          ref={backUpNow}
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-text-muted">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  When
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Kind
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  File
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Size
                </th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {backupsQuery.data.map((b) => (
                <tr key={b.fileName} className="border-t border-border">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-text">
                    {formatInstant(b.createdAt)}
                  </td>
                  <td className="py-1.5 pr-3 text-text-muted">{KIND_LABEL[b.kind] ?? b.kind}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs text-text-muted" title={b.path}>
                    {b.fileName}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-text-muted">
                    {formatBytes(b.bytes)}
                  </td>
                  <td className="py-1.5 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className={SMALL}
                        disabled={restore.isPending}
                        onClick={(event) => {
                          opener.current = event.currentTarget;
                          setConfirmingDelete(undefined);
                          restore.reset();
                          setConfirming(b);
                        }}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className={SMALL_DANGER}
                        disabled={deleteBackup.isPending}
                        onClick={(event) => {
                          opener.current = event.currentTarget;
                          setConfirming(undefined);
                          deleteBackup.reset();
                          setConfirmingDelete(b);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmBackup
        open={confirming !== undefined}
        title="Restore this backup?"
        pending={restore.isPending}
        onClose={() => setConfirming(undefined)}
        returnFocus={returnFocus}
        footer={
          <>
            <button
              type="button"
              className={SECONDARY}
              disabled={restore.isPending}
              onClick={() => setConfirming(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={DANGER_SOLID}
              disabled={restore.isPending || restoring === undefined}
              onClick={() => restoring && restore.mutate(restoring.fileName)}
            >
              {restore.isPending ? 'Restoring — restarting…' : 'Restore and restart'}
            </button>
          </>
        }
      >
        <p className="text-text">
          Restore <span className="font-mono text-xs">{restoring?.fileName}</span>? The current
          database is saved first as a “before restore” backup, then the app restarts on the
          restored copy. Anything entered since that backup will be in the saved copy, not the live
          one.
        </p>
        {restore.isError ? (
          <p role="alert" className="mt-2 text-danger">
            {errorMessage(restore.error)}
          </p>
        ) : null}
      </ConfirmBackup>

      <ConfirmBackup
        open={confirmingDelete !== undefined}
        title="Delete this backup?"
        pending={deleteBackup.isPending}
        onClose={() => setConfirmingDelete(undefined)}
        returnFocus={returnFocus}
        footer={
          <>
            <button
              type="button"
              className={SECONDARY}
              disabled={deleteBackup.isPending}
              onClick={() => setConfirmingDelete(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={SMALL_DANGER}
              disabled={deleteBackup.isPending || deleting === undefined}
              onClick={() =>
                deleting &&
                deleteBackup.mutate(
                  { fileName: deleting.fileName, permanent: true },
                  { onSuccess: () => setConfirmingDelete(undefined) },
                )
              }
            >
              Delete permanently
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={deleteBackup.isPending || deleting === undefined}
              onClick={() =>
                deleting &&
                deleteBackup.mutate(
                  { fileName: deleting.fileName, permanent: false },
                  { onSuccess: () => setConfirmingDelete(undefined) },
                )
              }
            >
              Move to Deleted backups
            </button>
          </>
        }
      >
        <p className="text-text">
          Delete <span className="font-mono text-xs">{deleting?.fileName}</span>? It moves to
          Deleted backups and can be put back for 30 days before it is removed for good. Delete
          permanently removes the file now and cannot be undone.
        </p>
        {deleteBackup.isError ? (
          <p role="alert" className="mt-2 text-danger">
            {errorMessage(deleteBackup.error)}
          </p>
        ) : null}
      </ConfirmBackup>

      <DeletedBackups />
    </section>
  );
}

/** The trash: shown only when something is in it. */
function DeletedBackups() {
  const deletedQuery = useDeletedBackups();
  const undelete = useUndeleteBackup();
  const purge = usePurgeBackup();
  const [confirmingPurge, setConfirmingPurge] = useState<DeletedBackupInfo | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const purging = useLastShown(confirmingPurge);

  if (deletedQuery.isError) {
    return (
      <div className="mt-4">
        <AsyncState
          status="error"
          label="Could not list deleted backups"
          error={deletedQuery.error}
        />
      </div>
    );
  }
  if (deletedQuery.isPending || deletedQuery.data.length === 0) return null;

  const error = undelete.error ?? purge.error;
  return (
    <div className="mt-6" data-testid="deleted-backups">
      <h3 className="text-sm font-semibold text-text">Deleted backups</h3>
      <p className="mb-2 text-xs text-text-muted">
        Kept for 30 days after deletion, then removed the next time the app starts.
      </p>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-danger">
          {errorMessage(error)}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Taken
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Kind
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                File
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Deleted
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Removed after
              </th>
              <th scope="col" className="py-1 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {deletedQuery.data.map((b) => (
              <tr key={b.fileName} className="border-t border-border">
                <td className="whitespace-nowrap py-1.5 pr-3 text-text">
                  {formatInstant(b.createdAt)}
                </td>
                <td className="py-1.5 pr-3 text-text-muted">{KIND_LABEL[b.kind] ?? b.kind}</td>
                <td className="py-1.5 pr-3 font-mono text-xs text-text-muted" title={b.path}>
                  {b.fileName}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-text-muted">
                  {formatInstant(b.deletedAt)}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-text-muted">
                  {formatInstant(b.purgeAt)}
                </td>
                <td className="py-1.5 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className={SMALL}
                      disabled={undelete.isPending}
                      onClick={() => {
                        purge.reset();
                        undelete.mutate(b.fileName);
                      }}
                    >
                      Undelete
                    </button>
                    <button
                      type="button"
                      className={SMALL_DANGER}
                      disabled={purge.isPending}
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        undelete.reset();
                        setConfirmingPurge(b);
                      }}
                    >
                      Delete permanently
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmBackup
        open={confirmingPurge !== undefined}
        title="Permanently delete this backup?"
        pending={purge.isPending}
        onClose={() => setConfirmingPurge(undefined)}
        returnFocus={() => (opener.current?.isConnected ? opener.current : undefined)}
        footer={
          <>
            <button
              type="button"
              className={SECONDARY}
              disabled={purge.isPending}
              onClick={() => setConfirmingPurge(undefined)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={DANGER_SOLID}
              disabled={purge.isPending || purging === undefined}
              onClick={() =>
                purging &&
                purge.mutate(purging.fileName, {
                  onSettled: () => setConfirmingPurge(undefined),
                })
              }
            >
              Delete permanently
            </button>
          </>
        }
      >
        <p className="text-text">
          Permanently delete <span className="font-mono text-xs">{purging?.fileName}</span>? The
          file is removed now and cannot be recovered.
        </p>
      </ConfirmBackup>
    </div>
  );
}
