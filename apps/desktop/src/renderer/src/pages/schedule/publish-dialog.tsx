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
import { useExport, usePublish, usePublishPreview } from '../../api-publish.js';
import { AsyncState } from '../../components/async-state.js';
import {
  DIALOG,
  errorMessage,
  INPUT,
  LABEL,
  OVERLAY,
  PRIMARY,
  SECONDARY,
} from '../../components/ui.js';
import { formatDate, periodLabel } from '../../format.js';

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
  const [acknowledged, setAcknowledged] = useState(false);
  const exportFile = useExport(period.id);
  const [shared, setShared] = useState<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (open) {
      setReason('');
      setAcknowledged(false);
      setShared(undefined);
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
  // A first publish of an empty grid would hand staff a blank schedule.
  const empty = preview !== undefined && !republish && preview.diff.added === 0;
  const canPublish =
    preview !== undefined &&
    !preview.nothingToPublish &&
    !empty &&
    !publish.isPending &&
    (preview.hardViolations === 0 || acknowledged) &&
    (!republish || reason.trim().length > 0);
  const done = publish.data;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !publish.isPending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content data-testid="publish-dialog" className={`${DIALOG} w-[40rem]`}>
          <Dialog.Title className="text-base font-semibold text-text">
            {done
              ? done.version.version === 1
                ? `${periodLabel(period)} is published`
                : `${periodLabel(period)} is published (version ${done.version.version})`
              : republish
                ? `Publish changes to ${periodLabel(period)}`
                : `Publish ${periodLabel(period)}`}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            {done
              ? 'This is now the schedule staff hold. ShiftNurse does not send it to anyone: print or export it to share it.'
              : 'Publishing freezes this version, books the fairness ledger and writes a backup. Edits after publishing need a reason and appear in the change log.'}
          </Dialog.Description>

          {done ? (
            <div className="mt-4 flex flex-col gap-2 text-sm text-text">
              <p>
                {done.version.version === 1
                  ? `${done.diff.added} shifts for ${done.diff.affectedNurseIds.length} nurses.`
                  : `${done.diff.added + done.diff.removed + done.diff.changed} shift changes affecting ${done.diff.affectedNurseIds.length} nurse${done.diff.affectedNurseIds.length === 1 ? '' : 's'}: let them know.`}{' '}
                Their nights, weekends and holidays now count toward fairness in future schedules.
              </p>
              <p className="text-text-muted">
                {done.backup
                  ? 'A copy of everything was saved first (Settings › Backups).'
                  : 'The backup could not be written — see Settings › Backups.'}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-xs text-text-muted">
                  {shared ? `Saved ${shared}` : 'Next: share it with the unit.'}
                </span>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={exportFile.isPending}
                  onClick={() =>
                    exportFile.mutate('pdf-grid', { onSuccess: (path) => path && setShared(path) })
                  }
                >
                  Print unit grid (PDF)
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={exportFile.isPending}
                  onClick={() =>
                    exportFile.mutate('pdf-nurses', {
                      onSuccess: (path) => path && setShared(path),
                    })
                  }
                >
                  Per-nurse sheets (PDF)
                </button>
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
                {preview.hardViolations === 0 && preview.softViolations === 0
                  ? 'No rule breaks or warnings.'
                  : `${preview.hardViolations} rule break${preview.hardViolations === 1 ? '' : 's'} · ${preview.softViolations} warning${preview.softViolations === 1 ? '' : 's'}`}
              </p>
              {empty ? (
                <p className="text-sm text-danger">
                  There are no shifts on this schedule yet. Generate or add shifts before publishing
                  it.
                </p>
              ) : null}
              {preview.hardViolations > 0 && !empty ? (
                <label className="flex items-start gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    data-testid="publish-acknowledge"
                    className="mt-0.5"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  <span>
                    I have reviewed the {preview.hardViolations} rule break
                    {preview.hardViolations === 1 ? '' : 's'} and want to publish anyway. They stay
                    flagged on the grid and in the exports.
                  </span>
                </label>
              ) : null}

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
                    Compliance alerts
                  </h3>
                  {/* What to act on first; the routine heads-ups are a count, listed on the page. */}
                  <ul className="mt-1 flex max-h-32 flex-col gap-0.5 overflow-y-auto text-xs">
                    {preview.alerts
                      .filter((a) => a.severity === 'critical')
                      .map((a) => (
                        <li
                          key={`${a.kind}:${a.nurseId ?? ''}:${a.date ?? ''}:${a.shiftTypeId ?? ''}`}
                          className="text-danger"
                        >
                          {a.message}
                        </li>
                      ))}
                  </ul>
                  {preview.alerts.some((a) => a.severity !== 'critical') ? (
                    <p className="mt-1 text-xs text-text-muted">
                      And {preview.alerts.filter((a) => a.severity !== 'critical').length} heads-ups
                      (shifts with no slack on the ratio, hours drifting), listed above the grid.
                    </p>
                  ) : null}
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
