/**
 * The Export menu: PDF grid, per-nurse PDF sheets, CSV (grid or shift list) and an Excel
 * workbook. Each item opens a native save dialog in main; the renderer only learns the path
 * that was written, which it shows briefly so the manager knows where the file went.
 */

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { OutputFormat } from '@shared/api.js';
import { useState } from 'react';
import { useExport } from '../../api-publish.js';
import { errorMessage } from '../requests/ui.js';

const ITEMS: readonly { format: OutputFormat; label: string }[] = [
  { format: 'pdf-grid', label: 'Unit grid (PDF)' },
  { format: 'pdf-nurses', label: 'Per-nurse sheets (PDF)' },
  { format: 'csv-grid', label: 'Grid (CSV)' },
  { format: 'csv-long', label: 'Shift list (CSV)' },
  { format: 'xlsx', label: 'Excel workbook' },
];

interface ExportMenuProps {
  periodId: string;
}

export function ExportMenu({ periodId }: ExportMenuProps) {
  const exportFile = useExport(periodId);
  const [lastPath, setLastPath] = useState<string | undefined>(undefined);

  return (
    <div className="flex items-center gap-2">
      {lastPath !== undefined ? (
        <span className="max-w-64 truncate text-xs text-text-muted" title={lastPath}>
          Saved {lastPath}
        </span>
      ) : null}
      {exportFile.isError ? (
        <span role="alert" className="text-xs text-danger">
          {errorMessage(exportFile.error)}
        </span>
      ) : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="export-open"
            disabled={exportFile.isPending}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text hover:bg-bg disabled:opacity-50"
          >
            {exportFile.isPending ? 'Exporting…' : 'Export'}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg"
          >
            {ITEMS.map((item) => (
              <DropdownMenu.Item
                key={item.format}
                onSelect={() =>
                  exportFile.mutate(item.format, {
                    onSuccess: (path) => setLastPath(path ?? undefined),
                  })
                }
                className="cursor-pointer rounded px-2 py-1.5 text-sm text-text outline-none data-[highlighted]:bg-bg"
              >
                {item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
