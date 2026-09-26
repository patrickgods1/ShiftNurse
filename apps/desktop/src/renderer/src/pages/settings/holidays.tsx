/**
 * The unit's holiday calendar. Grouped by year because a manager configuring this thinks in
 * "next year's holidays" terms, and the fairness ledger tracks holidays-worked per period —
 * getting the major/minor flag right here is what makes that equity check meaningful.
 */

import type { Holiday } from '@shiftnurse/core';
import { useState } from 'react';
import { useCreateHoliday, useDeleteHoliday, useHolidays } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { formatDateWithWeekday } from '../../format.js';
import { useUnitId } from '../../unit-context.js';

function yearOf(date: string): string {
  return date.slice(0, 4);
}

export default function HolidaysPanel() {
  const confirm = useConfirm();
  const unitId = useUnitId();
  const holidaysQuery = useHolidays(unitId);
  const createHoliday = useCreateHoliday();
  const deleteHoliday = useDeleteHoliday();

  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [isMajor, setIsMajor] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (holidaysQuery.isPending) {
    return <AsyncState status="loading" label="Loading holidays" />;
  }
  if (holidaysQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load holidays" error={holidaysQuery.error} />
    );
  }

  const sorted = [...holidaysQuery.data].sort((a, b) => a.date.localeCompare(b.date));
  const byYear = new Map<string, Holiday[]>();
  for (const holiday of sorted) {
    const year = yearOf(holiday.date);
    const list = byYear.get(year) ?? [];
    list.push(holiday);
    byYear.set(year, list);
  }

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-text">Holidays</h2>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (date === '' || name.trim() === '') {
            setError('Date and name are required');
            return;
          }
          setError(undefined);
          createHoliday.mutate(
            { unitId, date: date as Holiday['date'], name: name.trim(), isMajor },
            {
              onSuccess: () => {
                setDate('');
                setName('');
                setIsMajor(false);
              },
            },
          );
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Date
          <input
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          Name
          <input
            type="text"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
          />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-text">
          <input
            type="checkbox"
            checked={isMajor}
            onChange={(event) => setIsMajor(event.target.checked)}
          />
          Major holiday
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          Add holiday
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <div data-testid="holiday-list" className="flex flex-col gap-4">
        {byYear.size === 0 ? (
          <p className="text-sm text-text-muted">No holidays configured yet.</p>
        ) : (
          [...byYear.entries()].map(([year, holidays]) => (
            <div key={year}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {year}
              </h3>
              <ul className="flex flex-col gap-1">
                {holidays.map((holiday) => (
                  <li
                    key={holiday.id}
                    className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <span className="text-text">
                      {formatDateWithWeekday(holiday.date)} — {holiday.name}
                      {holiday.isMajor ? (
                        <span className="ml-2 rounded-full bg-accent/20 px-2 py-0.5 text-xs text-accent">
                          Major
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Delete "${holiday.name}"?`,
                            confirmLabel: 'Delete',
                          })
                        ) {
                          deleteHoliday.mutate({ id: holiday.id, unitId });
                        }
                      }}
                      className="rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg"
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
