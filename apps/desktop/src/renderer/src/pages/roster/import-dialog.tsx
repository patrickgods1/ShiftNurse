/**
 * Roster CSV import: pick a file, show what it will do, then commit. Import is blocked while
 * parse errors exist rather than importing the rows that did parse — a partial import that
 * silently drops the rows with typos is worse than making the manager fix the spreadsheet,
 * because the missing nurses won't be noticed until the schedule comes up short.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import type { RosterImportPreview, RosterImportSummary } from '../../../../shared/api.js';
import { useImportRosterRows, usePickRosterImportFile } from '../../api.js';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
}

export function ImportDialog({ open, onOpenChange, unitId }: ImportDialogProps) {
  const pickFile = usePickRosterImportFile();
  const importRows = useImportRosterRows(unitId);
  const [preview, setPreview] = useState<RosterImportPreview | undefined>(undefined);
  const [summary, setSummary] = useState<RosterImportSummary | undefined>(undefined);

  function reset() {
    setPreview(undefined);
    setSummary(undefined);
    pickFile.reset();
    importRows.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handlePickFile() {
    const result = await pickFile.mutateAsync(unitId);
    if (result !== undefined) setPreview(result);
  }

  function handleImport() {
    if (preview === undefined) return;
    importRows.mutate(preview.rows, {
      onSuccess: (result) => {
        setSummary(result);
        setPreview(undefined);
      },
    });
  }

  const newCount = preview
    ? preview.rows.filter((r) => !preview.existingEmployeeIds.includes(r.nurse.employeeId)).length
    : 0;
  const updateCount = preview ? preview.rows.length - newCount : 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 max-h-[85vh] w-[640px] -translate-x-1/2 -translate-y-1/2
            overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">
            Import roster from CSV
          </Dialog.Title>

          {summary !== undefined ? (
            <div className="text-sm text-text">
              <p className="mb-2 font-medium text-success">Import complete.</p>
              <ul className="list-inside list-disc space-y-1">
                <li>{summary.created} nurse(s) created</li>
                <li>{summary.updated} nurse(s) updated</li>
                <li>{summary.credentialsCreated.length} new credential type(s) added</li>
                <li>{summary.credentialsGranted} credential(s) granted</li>
                <li>{summary.credentialsUpdated} credential expiry update(s)</li>
              </ul>
              <div className="mt-4 flex justify-end">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
                  >
                    Done
                  </button>
                </Dialog.Close>
              </div>
            </div>
          ) : preview === undefined ? (
            <div>
              <p className="mb-4 text-sm text-text-muted">
                Choose a CSV file exported from ShiftNurse or matching its column layout.
              </p>
              {pickFile.isError ? (
                <p role="alert" className="mb-3 text-sm text-danger">
                  Could not read that file.
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handlePickFile}
                  disabled={pickFile.isPending}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                    disabled:opacity-60"
                >
                  {pickFile.isPending ? 'Opening…' : 'Choose file…'}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="mb-2 text-sm text-text-muted">{preview.path}</p>
              <p className="mb-3 text-sm text-text">
                {newCount} new nurse(s), {updateCount} existing nurse(s) to update.
              </p>

              {preview.errors.length > 0 ? (
                <div className="mb-4">
                  <p className="mb-2 text-sm font-medium text-danger">
                    {preview.errors.length} row(s) have errors — fix the spreadsheet and re-import.
                  </p>
                  <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-text-muted">
                          <th className="px-2 py-1">Line</th>
                          <th className="px-2 py-1">Column</th>
                          <th className="px-2 py-1">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.map((err) => (
                          <tr
                            key={`${err.line}:${err.column}:${err.message}`}
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

              {importRows.isError ? (
                <p role="alert" className="mb-3 text-sm text-danger">
                  Import failed. Nothing was changed.
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPreview(undefined)}
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                >
                  Choose a different file
                </button>
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={preview.errors.length > 0 || importRows.isPending}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                    disabled:opacity-60"
                >
                  {importRows.isPending ? 'Importing…' : `Import ${preview.rows.length} nurses`}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
