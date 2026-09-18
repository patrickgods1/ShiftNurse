/**
 * Time-off requests awaiting (or past) a decision. Defaults to `pending` because that's the
 * manager's actual queue; the filter exists for looking something up after the fact.
 */

import type { TimeOffRequest, TimeOffStatus } from '@shiftnurse/core';
import { useState } from 'react';
import { useNurses, useTimeOff } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { type Column, DataTable } from '../components/data-table.js';
import { PageHeader } from '../components/page-header.js';
import { formatDate } from '../format.js';
import { useUnitId } from '../unit-context.js';

type FilterValue = TimeOffStatus | 'all';

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'all', label: 'All' },
];

export default function RequestsPage() {
  const unitId = useUnitId();
  const [filter, setFilter] = useState<FilterValue>('pending');
  const timeOffQuery = useTimeOff(unitId, filter === 'all' ? undefined : filter);
  const nursesQuery = useNurses(unitId);

  const nurseName = (nurseId: string): string => {
    const nurse = nursesQuery.data?.find((n) => n.id === nurseId);
    return nurse !== undefined ? `${nurse.firstName} ${nurse.lastName}` : nurseId;
  };

  const columns: Column<TimeOffRequest>[] = [
    {
      key: 'nurse',
      header: 'Nurse',
      render: (request) => nurseName(request.nurseId),
      sortValue: (request) => nurseName(request.nurseId).toLowerCase(),
    },
    {
      key: 'dates',
      header: 'Dates',
      render: (request) => `${formatDate(request.startDate)} – ${formatDate(request.endDate)}`,
      sortValue: (request) => request.startDate,
    },
    { key: 'type', header: 'Type', render: (request) => request.type },
    { key: 'status', header: 'Status', render: (request) => request.status },
    { key: 'enteredBy', header: 'Entered by', render: (request) => request.enteredBy },
  ];

  return (
    <div>
      <PageHeader title="Requests" description="Time-off requests for this unit" />
      <fieldset className="mb-4 flex gap-2 border-0 p-0">
        <legend className="sr-only">Filter by status</legend>
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            className={`rounded-md border border-border px-3 py-1 text-sm ${
              filter === option.value ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
            }`}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      {timeOffQuery.isPending || nursesQuery.isPending ? (
        <AsyncState status="loading" label="Loading requests" />
      ) : timeOffQuery.isError ? (
        <AsyncState status="error" label="Could not load requests" error={timeOffQuery.error} />
      ) : nursesQuery.isError ? (
        <AsyncState status="error" label="Could not load nurses" error={nursesQuery.error} />
      ) : (
        <DataTable
          columns={columns}
          rows={timeOffQuery.data}
          rowKey={(request) => request.id}
          emptyLabel="No requests match this filter."
        />
      )}
    </div>
  );
}
