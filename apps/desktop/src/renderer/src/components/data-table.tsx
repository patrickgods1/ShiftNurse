/**
 * A generic typed table so each page declares columns as data instead of hand-writing a
 * <table> and re-solving "what if the list is empty" every time. Sorting is opt-in per column
 * (roster asks for name sorting; requests doesn't need it) rather than forced on every table.
 */

import { type ReactNode, useMemo, useState } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** When present, clicking the header sorts by this comparable value. */
  sortValue?: (row: T) => string | number;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyLabel?: string;
  /** When present, rows are clickable (e.g. to open a detail view) and keyboard-activatable. */
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({ columns, rows, rowKey, emptyLabel, onRowClick }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | undefined>(undefined);

  const sorted = useMemo(() => {
    if (sort === undefined) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (column?.sortValue === undefined) return rows;
    const getValue = column.sortValue;
    return [...rows].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (av < bv) return -1 * sort.direction;
      if (av > bv) return 1 * sort.direction;
      return 0;
    });
  }, [rows, sort, columns]);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-8 text-center text-text-muted">
        {emptyLabel ?? 'Nothing to show'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-2 font-medium">
                {column.sortValue !== undefined ? (
                  <button
                    type="button"
                    className="flex items-center gap-1 hover:text-text focus-visible:text-text"
                    onClick={() =>
                      setSort((prev) =>
                        prev?.key === column.key
                          ? { key: column.key, direction: prev.direction === 1 ? -1 : 1 }
                          : { key: column.key, direction: 1 },
                      )
                    }
                  >
                    {column.header}
                    {sort?.key === column.key ? (sort.direction === 1 ? '▲' : '▼') : null}
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-border last:border-0 ${
                onRowClick !== undefined ? 'cursor-pointer hover:bg-bg' : ''
              }`}
              tabIndex={onRowClick !== undefined ? 0 : undefined}
              role={onRowClick !== undefined ? 'button' : undefined}
              onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick !== undefined
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 text-text">
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
