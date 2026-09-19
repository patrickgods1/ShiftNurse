/**
 * Publish / republish, with everything the manager should see first: how many hard rules the
 * draft still breaks, what will change for whom against the last version, the reasoned edits
 * since then, and the compliance alerts. A first publish needs no reason; a republish does,
 * because staff already hold the previous version and the reason is what they will be told.
 *
 * The preview is fetched only while the dialog is open — it runs validation, the diff and
 * the alert pass, which is cheap (tens of milliseconds) but not free on every grid edit.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id, Nurse, SchedulePeriod, ShiftType } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import { usePublish, usePublishPreview } from '../../api-publish.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDate } from '../../format.js';
import { DIALOG, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../requests/ui.js';

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  period: SchedulePeriod;
  nurses: readonly Nurse[];
  shiftTypes: readonly ShiftType[];
}

const MAX_LISTED = 60;

export function PublishDialog({
  open,
  onOpenChange,
  unitId,
  period,
  nurses,
  shiftTypes,
}: PublishDialogProps) {
  const previewQuery = usePublishPreview(period.id, open);
  const publish = usePublish(period.id, unitId);
  const [reason, setReason] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (open) {
      setReason('');
      publish.reset();
    }
  }, [open]);

  const nurseName = useMemo(() => {
    const byId = new Map(nurses.map((n) => [n.id, n]));
    return (id: Id) => {
      const n = byId.get(id);
      return n ? `${n.lastName}, ${n.firstName}` : id;
    };
  }, [nurses]);
  const shiftLabel = useMemo(() => {
    const byId = new Map(shiftTypes.map((s) => [s.id, s]));
    return (id: Id) => byId.get(id)?.abbreviation ?? id;
  }, [shiftTypes]);

  const preview = previewQuery.data;
  const republish = preview?.latestVersion !== undefined;
  const canPublish =
    preview !== undefined &&
    !preview.nothingToPublish &&
    !publish.isPending &&
    (!republish || reason.trim().length > 0);
  const done = publish.data;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !publish.isPending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content data-testid="publish-dialog" className={`${DIALOG} w-[40rem]`}>
          <Dialog.Title className="text-base font-semibold text-text">
            {done
              ? `Published version ${done.version.version}`
              : republish
                ? `Publish changes to ${period.name}`
                : `Publish ${period.name}`}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {done
              ? 'The schedule is now what staff hold. A backup was written first.'
              : 'Publishing freezes this version, books the fairness ledger and writes a backup. Edits after publishing need a reason and appear in the change log.'}
          </Dialog.Description>

          {done ? (
            <div className="mt-4 flex flex-col gap-2 text-sm text-text">
              <p>
                {done.diff.added} added · {done.diff.removed} removed · {done.diff.changed} changed
                · {done.ledgerEntries} ledger rows written
              </p>
              <p className="text-text-muted">
                {done.backup
                  ? `Backup: ${done.backup.fileName}`
                  : 'The backup could not be written — see Settings › Backups.'}
              </p>
              <div className="mt-2 flex justify-end">
                <Dialog.Close asChild>
                  <button type="button" className={PRIMARY}>
                    Done
                  </button>
                </Dialog.Close>
              </div>
            </div>
          ) : previewQuery.isPending ? (
            <AsyncState status="loading" label="Checking the schedule" />
          ) : previewQuery.isError ? (
            <AsyncState
              status="error"
              label="Could not prepare the publish"
              error={previewQuery.error}
            />
          ) : preview ? (
            <form
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canPublish) publish.mutate(reason.trim() || undefined);
              }}
            >
              <p
                className={`text-sm font-medium ${
                  preview.hardViolations > 0
                    ? 'text-danger'
                    : preview.softViolations > 0
                      ? 'text-warn'
                      : 'text-success'
                }`}
              >
                {preview.hardViolations} hard · {preview.softViolations} soft violation
                {preview.hardViolations + preview.softViolations === 1 ? '' : 's'}
                {preview.hardViolations > 0
                  ? ' — publishing anyway is your call; the violations stay on the grid.'
                  : ''}
              </p>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {republish ? `Since version ${preview.latestVersion?.version}` : 'What goes out'}
                </h3>
                <p className="mt-1 text-sm text-text" data-testid="publish-diff">
                  {preview.nothingToPublish
                    ? 'Nothing has changed since the last version.'
                    : republish
                      ? `${preview.diff.added} added · ${preview.diff.removed} removed · ${preview.diff.changed} changed · ${preview.diff.affectedNurseIds.length} nurses affected`
                      : `${preview.diff.added} shifts across ${preview.diff.affectedNurseIds.length} nurses`}
                </p>
                {republish && preview.diff.changes.length > 0 ? (
                  <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto text-xs text-text-muted">
                    {preview.diff.changes.slice(0, MAX_LISTED).map((c) => (
                      <li key={`${c.kind}:${c.nurseId}:${c.date}:${c.shiftTypeId}`}>
                        <span className="font-medium capitalize text-text">{c.kind}</span> —{' '}
                        {nurseName(c.nurseId)} · {shiftLabel(c.shiftTypeId)} on {formatDate(c.date)}
                        {c.fields ? ` (${c.fields.join(', ')})` : ''}
                      </li>
                    ))}
                    {preview.diff.changes.length > MAX_LISTED ? (
                      <li>…and {preview.diff.changes.length - MAX_LISTED} more</li>
                    ) : null}
                  </ul>
                ) : null}
              </section>

              {preview.pendingChanges.length > 0 ? (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Reasons recorded ({preview.pendingChanges.length})
                  </h3>
                  <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto text-xs text-text-muted">
                    {preview.pendingChanges.map((c) => (
                      <li key={c.id}>
                        {nurseName(c.nurseId)} · {c.kind} · “{c.reason}”
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {preview.alerts.length > 0 ? (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Compliance alerts ({preview.alerts.length})
                  </h3>
                  <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto text-xs">
                    {preview.alerts.map((a) => (
                      <li
                        key={`${a.kind}:${a.nurseId ?? ''}:${a.date ?? ''}:${a.shiftTypeId ?? ''}`}
                        className={a.severity === 'critical' ? 'text-danger' : 'text-warn'}
                      >
                        {a.message}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <label className={LABEL}>
                Reason{republish ? '' : ' (optional)'}
                <textarea
                  data-testid="publish-reason"
                  className={`${INPUT} min-h-16`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={
                    republish
                      ? 'What changed and why — staff will see this'
                      : 'Optional note for the audit trail'
                  }
                />
              </label>

              {publish.isError ? (
                <p role="alert" className="text-sm text-danger">
                  {errorMessage(publish.error)}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button type="button" className={SECONDARY} disabled={publish.isPending}>
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  data-testid="publish-confirm"
                  className={PRIMARY}
                  disabled={!canPublish}
                >
                  {publish.isPending
                    ? 'Publishing…'
                    : republish
                      ? `Publish version ${(preview.latestVersion?.version ?? 0) + 1}`
                      : 'Publish'}
                </button>
              </div>
            </form>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
