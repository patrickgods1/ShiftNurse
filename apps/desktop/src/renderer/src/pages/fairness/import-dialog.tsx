/**
 * Historical schedule import: seeds the fairness ledger from schedules that predate the app, so
 * a unit's first in-app period isn't scored against zero history. Mirrors the roster import
 * flow in pages/roster/import-dialog.tsx — pick a file, preview what it will do, block on
 * parse errors, commit — because a partial import that silently drops bad rows would quietly
 * under-count a nurse's carried burden instead of asking the manager to fix the spreadsheet.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import type { HistoryImportPreview, HistoryImportSummary } from '../../../../shared/api.js';
import { useImportHistory, usePickHistoryImportFile } from '../../api-fairness.js';
import { formatDate } from '../../format.js';

interface ImportHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
}

export function ImportHistoryDialog({ open, onOpenChange, unitId }: ImportHistoryDialogProps) {
  const pickFile = usePickHistoryImportFile();
  const importHistory = useImportHistory(unitId);
  const [preview, setPreview] = useState<HistoryImportPreview | undefined>(undefined);
  const [summary, setSummary] = useState<HistoryImportSummary | undefined>(undefined);

  function reset() {
    setPreview(undefined);
    setSummary(undefined);
    pickFile.reset();
    importHistory.reset();
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
    importHistory.mutate(preview.rows, {
      onSuccess: (result) => {
        setSummary(result);
        setPreview(undefined);
      },
    });
  }

  const replacingCount = preview?.periods.filter((p) => p.replacesExisting).length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 max-h-[85vh] w-[680px] -translate-x-1/2 -translate-y-1/2
            overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">
            Import history from CSV
          </Dialog.Title>

          {summary !== undefined ? (
            <div className="text-sm text-text">
              <p className="mb-2 font-medium text-success">Import complete.</p>
              <ul className="list-inside list-disc space-y-1">
                <li>{summary.periodsImported} period(s) imported</li>
                <li>
                  {summary.entriesWritten} ledger entr{summary.entriesWritten === 1 ? 'y' : 'ies'}{' '}
                  written
                </li>
                <li>
                  {summary.entriesReplaced} entr{summary.entriesReplaced === 1 ? 'y' : 'ies'}{' '}
                  replaced
                </li>
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
                Choose a CSV of past shifts to seed the fairness ledger. Expected columns:{' '}
                <code className="rounded bg-bg px-1 py-0.5">employee_id</code>,{' '}
                <code className="rounded bg-bg px-1 py-0.5">date</code>,{' '}
                <code className="rounded bg-bg px-1 py-0.5">shift</code> — where shift is the shift
                type abbreviation (e.g. D12, N12).
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
                {preview.periods.length} pay period(s) found, {replacingCount} already on record and
                will be replaced.
              </p>

              {preview.errors.length > 0 ? (
                <div className="mb-4">
                  <p className="mb-2 text-sm font-medium text-danger">
                    {preview.errors.length} row(s) have errors — fix the file and re-import.
                  </p>
                  <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-text-muted">
                          <th scope="col" className="px-2 py-1">
                            Line
                          </th>
                          <th scope="col" className="px-2 py-1">
                            Message
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.map((err) => (
                          <tr
                            key={`${err.line}:${err.message}`}
                            className="border-b border-border last:border-0"
                          >
                            <td className="px-2 py-1 text-text">{err.line}</td>
                            <td className="px-2 py-1 text-text">{err.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              {preview.periods.length > 0 ? (
                <div className="mb-4 max-h-56 overflow-y-auto rounded-md border border-border">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-text-muted">
                        <th scope="col" className="px-2 py-1">
                          Period
                        </th>
                        <th scope="col" className="px-2 py-1">
                          Shifts
                        </th>
                        <th scope="col" className="px-2 py-1">
                          Nurses
                        </th>
                        <th scope="col" className="px-2 py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {preview.periods.map((period) => (
                        <tr key={period.periodId} className="border-b border-border last:border-0">
                          <td className="px-2 py-1 text-text">
                            {formatDate(period.start)} – {formatDate(period.end)}
                          </td>
                          <td className="px-2 py-1 text-text">{period.shifts}</td>
                          <td className="px-2 py-1 text-text">{period.nurses}</td>
                          <td className="px-2 py-1">
                            {period.replacesExisting ? (
                              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-warn">
                                replaces existing
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {importHistory.isError ? (
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
                  disabled={preview.errors.length > 0 || importHistory.isPending}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                    disabled:opacity-60"
                >
                  {importHistory.isPending
                    ? 'Importing…'
                    : `Import ${preview.periods.length} period(s)`}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
