/**
 * A generic typed table so each page declares columns as data instead of hand-writing a
 * <table> and re-solving "what if the list is empty" every time. Sorting is opt-in per column
 * (roster asks for name sorting; requests doesn't need it) rather than forced on every table.
 *
 * Rows open through a button in the first cell, so the table keeps its row/column semantics:
 * a role on the <tr> would make a screen reader announce the whole row as one button.
 */

import { type ReactNode, useMemo, useState } from 'react';

// Numeric collation so "E9" sorts before "E10"; base sensitivity so case and accents don't
// reorder a surname list ("Ödegaard" sits with the O's, not after "z").
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

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
  /** When present, rows open a detail view: a click anywhere, or the button in the first cell. */
  onRowClick?: (row: T) => void;
  /** The first-cell button's accessible name, e.g. "Open Adams, Alice". */
  rowLabel?: (row: T) => string;
  /** The column the table opens sorted by, ascending (e.g. a roster by surname). */
  initialSortKey?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyLabel,
  onRowClick,
  rowLabel,
  initialSortKey,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | undefined>(
    initialSortKey !== undefined ? { key: initialSortKey, direction: 1 } : undefined,
  );

  const sorted = useMemo(() => {
    if (sort === undefined) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (column?.sortValue === undefined) return rows;
    const getValue = column.sortValue;
    return [...rows].sort((a, b) => {
      return compareValues(getValue(a), getValue(b)) * sort.direction;
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
              <th
                key={column.key}
                scope="col"
                className="px-3 py-2 font-medium"
                aria-sort={
                  column.sortValue === undefined
                    ? undefined
                    : sort?.key === column.key
                      ? sort.direction === 1
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                }
              >
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
                    {sort?.key === column.key ? (
                      <span aria-hidden="true">{sort.direction === 1 ? '▲' : '▼'}</span>
                    ) : null}
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
              onClick={onRowClick !== undefined ? () => onRowClick(row) : undefined}
            >
              {columns.map((column, index) => (
                <td key={column.key} className="px-3 py-2 text-text">
                  {index === 0 && onRowClick !== undefined ? (
                    <button
                      type="button"
                      aria-label={rowLabel?.(row)}
                      className="text-left font-medium text-text hover:underline focus-visible:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRowClick(row);
                      }}
                    >
                      {column.render(row)}
                    </button>
                  ) : (
                    column.render(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
