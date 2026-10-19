/**
 * Roster CSV import: pick a file, show what it will do, then commit. Import is blocked while
 * parse errors exist rather than importing the rows that did parse — a partial import that
 * silently drops the rows with typos is worse than making the manager fix the spreadsheet,
 * because the missing nurses won't be noticed until the schedule comes up short.
 *
 * The preview lists what changes for each existing nurse, which columns the file lacks (left
 * alone), and asks before reactivating anyone.
 */

import { type Id, OPTIONAL_ROSTER_COLUMNS, type RosterFieldChange } from '@shiftnurse/core';
import { useEffect, useRef, useState } from 'react';
import type { RosterImportPreview, RosterImportSummary } from '../../../../shared/api.js';
import { useImportRosterRows, usePickRosterImportFile } from '../../api.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, PRIMARY, SECONDARY } from '../../components/ui.js';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmt = (c: RosterFieldChange) => `${c.field} ${c.from ?? 'not set'} → ${c.to ?? 'cleared'}`;

export function ImportDialog({ open, onOpenChange, unitId }: ImportDialogProps) {
  const pickFile = usePickRosterImportFile();
  const importRows = useImportRosterRows(unitId);
  const [preview, setPreview] = useState<RosterImportPreview | undefined>(undefined);
  const [summary, setSummary] = useState<RosterImportSummary | undefined>(undefined);
  const [reactivate, setReactivate] = useState(false);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  // The control that was clicked unmounts when the step changes, which would drop focus to <body>.
  useEffect(() => {
    if (preview !== undefined) previewHeading.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (summary !== undefined) doneHeading.current?.focus();
  }, [summary]);

  function reset() {
    setPreview(undefined);
    setSummary(undefined);
    setReactivate(false);
    pickFile.reset();
    importRows.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handlePickFile() {
    pickFile.mutate(unitId, {
      onSuccess: (result) => {
        if (result !== undefined) {
          setReactivate(false);
          setPreview(result);
        }
      },
    });
  }

  function handleImport() {
    if (preview === undefined) return;
    importRows.mutate(
      { rows: preview.rows, options: { columns: preview.columns, reactivate } },
      {
        onSuccess: (result) => {
          setSummary(result);
          setPreview(undefined);
        },
      },
    );
  }

  const plan = preview?.plan ?? [];
  const created = plan.filter((r) => r.action === 'create').length;
  const updated = plan.filter((r) => r.action === 'update').length;
  const unchanged = plan.filter((r) => r.action === 'unchanged').length;
  const changed = plan.filter((r) => r.action === 'update');
  const inactive = plan.filter((r) => r.inactive);
  const clears = plan.filter((r) => r.changes.some((c) => c.to === undefined)).length;
  const absent = OPTIONAL_ROSTER_COLUMNS.filter(
    (c) => c !== 'credentials' && !(preview?.columns ?? []).includes(c),
  );

  return (
    <Modal open={open} onOpenChange={handleOpenChange} size="lg" title="Import roster from CSV">
      <div className="mt-4">
        {summary !== undefined ? (
          <div className="text-sm text-text">
            <h3 ref={doneHeading} tabIndex={-1} className="mb-2 font-medium text-success">
              Import complete.
            </h3>
            <ul className="list-inside list-disc space-y-1">
              <li>{plural(summary.created, 'nurse')} created</li>
              <li>{plural(summary.updated, 'nurse')} updated</li>
              <li>{summary.unchanged} unchanged</li>
              <li>{plural(summary.credentialsCreated.length, 'new credential type')} added</li>
              <li>{plural(summary.credentialsGranted, 'credential')} granted</li>
              <li>{plural(summary.credentialsUpdated, 'credential expiry update')}</li>
              {summary.reactivated.length > 0 ? (
                <li>Reactivated: {summary.reactivated.join('; ')}</li>
              ) : null}
              {summary.keptInactive.length > 0 ? (
                <li>Left inactive: {summary.keptInactive.join('; ')}</li>
              ) : null}
            </ul>
            <div className="mt-4 flex justify-end">
              <button type="button" className={PRIMARY} onClick={() => handleOpenChange(false)}>
                Done
              </button>
            </div>
          </div>
        ) : preview === undefined ? (
          <div>
            <p className="mb-4 text-sm text-text-muted">
              Choose a CSV file exported from ShiftNurse or matching its column layout.
            </p>
            {pickFile.isError ? (
              <p role="alert" className="mb-3 text-sm text-danger">
                Could not read that file: {errorMessage(pickFile.error)}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => handleOpenChange(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePickFile}
                disabled={pickFile.isPending}
                className={PRIMARY}
              >
                {pickFile.isPending ? 'Opening…' : 'Choose file…'}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="mb-2 text-sm text-text-muted">{preview.path}</p>
            <h3 ref={previewHeading} tabIndex={-1} className="mb-2 text-sm font-semibold text-text">
              Check the import
            </h3>
            <p className="mb-3 text-sm text-text">
              {created} new, {updated} with changes, {unchanged} unchanged.
            </p>
            {absent.length > 0 ? (
              <p className="mb-3 text-sm text-text-muted">
                This file has no {absent.join(', ')} column{absent.length === 1 ? '' : 's'}; those
                details are left as they are.
              </p>
            ) : null}
            {clears > 0 ? (
              <p className="mb-3 text-sm text-warn">
                {clears} {clears === 1 ? 'nurse has' : 'nurses have'} a detail cleared because the
                cell is blank. Check the list below.
              </p>
            ) : null}
            {inactive.length > 0 ? (
              <div className="mb-3 text-sm text-text">
                <p>
                  {plural(inactive.length, 'nurse')} in the file{' '}
                  {inactive.length === 1 ? 'is' : 'are'} inactive on this unit:{' '}
                  {inactive.map((r) => r.name).join('; ')}.
                </p>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={reactivate}
                    onChange={(e) => setReactivate(e.target.checked)}
                  />
                  Reactivate them, so Generate can schedule them again
                </label>
                <p className="text-xs text-text-muted">
                  Left unticked, their details are updated and they stay inactive.
                </p>
              </div>
            ) : null}
            {changed.length > 0 ? (
              <details className="mb-3 text-sm text-text">
                <summary className="cursor-pointer">
                  {`What changes for existing nurses (${changed.length})`}
                </summary>
                <ul className="mt-1 list-inside list-disc space-y-1">
                  {changed.map((r) => (
                    <li key={r.employeeId}>{`${r.name}: ${r.changes.map(fmt).join('; ')}`}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {preview.errors.length > 0 ? (
              <div className="mb-4">
                <p className="mb-2 text-sm font-medium text-danger">
                  {plural(preview.errors.length, 'row')}{' '}
                  {preview.errors.length === 1 ? 'has' : 'have'} errors — fix the spreadsheet and
                  re-import.
                </p>
                <div className="max-h-56 overflow-auto rounded-md border border-border">
                  <table aria-label="Rows with errors" className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-text-muted">
                        <th className="px-2 py-1" title="The row number your spreadsheet shows">
                          Row
                        </th>
                        <th className="px-2 py-1">Column</th>
                        <th className="px-2 py-1">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.errors.map((err, i) => (
                        <tr
                          // biome-ignore lint/suspicious/noArrayIndexKey: the same cell can fail the same way twice
                          key={i}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-2 py-1 text-text">{err.line}</td>
                          <td className="px-2 py-1 text-text">{err.column}</td>
                          <td className="px-2 py-1 text-text">{err.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {preview.rows.length === 0 ? (
              <p className="mb-3 text-sm text-text-muted">The file has no nurse rows.</p>
            ) : null}

            {importRows.isError ? (
              <p role="alert" className="mb-3 text-sm text-danger">
                Import failed. Nothing was changed. {errorMessage(importRows.error)}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setPreview(undefined)} className={SECONDARY}>
                Choose a different file
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={
                  preview.errors.length > 0 || preview.rows.length === 0 || importRows.isPending
                }
                className={PRIMARY}
              >
                {importRows.isPending
                  ? 'Importing…'
                  : `Import ${plural(preview.rows.length, 'nurse')}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
