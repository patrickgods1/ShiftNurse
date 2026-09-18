/**
 * Period list plus a per-date assignment count for whichever period is selected. A full grid
 * (nurse × day) is a later milestone once the solver and rules UI exist; this keeps the page
 * honest about what data is actually available today rather than mocking a grid.
 */

import type { SchedulePeriod } from '@shiftnurse/core';
import { useState } from 'react';
import { useAssignments, usePeriods } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { type Column, DataTable } from '../components/data-table.js';
import { PageHeader } from '../components/page-header.js';
import { formatDate, formatDateWithWeekday } from '../format.js';
import { useUnitId } from '../unit-context.js';

const periodColumns: Column<SchedulePeriod>[] = [
  { key: 'name', header: 'Name', render: (period) => period.name, sortValue: (p) => p.name },
  {
    key: 'dates',
    header: 'Dates',
    render: (period) => `${formatDate(period.startDate)} – ${formatDate(period.endDate)}`,
    sortValue: (p) => p.startDate,
  },
  { key: 'status', header: 'Status', render: (period) => period.status },
];

function AssignmentsByDate({ periodId }: { periodId: string }) {
  const assignmentsQuery = useAssignments(periodId);

  if (assignmentsQuery.isPending) {
    return <AsyncState status="loading" label="Loading assignments" />;
  }
  if (assignmentsQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load assignments"
        error={assignmentsQuery.error}
      />
    );
  }

  const counts = new Map<string, number>();
  for (const assignment of assignmentsQuery.data) {
    counts.set(assignment.date, (counts.get(assignment.date) ?? 0) + 1);
  }
  const dates = [...counts.keys()].sort();

  if (dates.length === 0) {
    return <p className="text-sm text-text-muted">No assignments in this period yet.</p>;
  }

  return (
    <div className="grid grid-cols-4 gap-3">
      {dates.map((date) => (
        <div key={date} className="rounded-md border border-border bg-surface p-3">
          <p className="text-sm text-text-muted">{formatDateWithWeekday(date)}</p>
          <p className="mt-1 text-lg font-semibold text-text">{counts.get(date)}</p>
        </div>
      ))}
    </div>
  );
}

export default function SchedulePage() {
  const unitId = useUnitId();
  const periodsQuery = usePeriods(unitId);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const selected =
    selectedId !== undefined ? periodsQuery.data?.find((p) => p.id === selectedId) : undefined;

  return (
    <div>
      <PageHeader title="Schedule" description="Scheduling periods for this unit" />
      {periodsQuery.isPending ? (
        <AsyncState status="loading" label="Loading periods" />
      ) : periodsQuery.isError ? (
        <AsyncState status="error" label="Could not load periods" error={periodsQuery.error} />
      ) : (
        <>
          <div className="mb-6">
            <DataTable
              columns={[
                ...periodColumns,
                {
                  key: 'select',
                  header: '',
                  render: (period) => (
                    <button
                      type="button"
                      className="text-sm text-accent underline underline-offset-2 hover:no-underline"
                      onClick={() => setSelectedId(period.id)}
                    >
                      {selectedId === period.id ? 'Selected' : 'View'}
                    </button>
                  ),
                },
              ]}
              rows={periodsQuery.data}
              rowKey={(period) => period.id}
              emptyLabel="No scheduling periods yet."
            />
          </div>
          {selected !== undefined ? (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-text">
                Assignments per date — {selected.name}
              </h2>
              <AssignmentsByDate periodId={selected.id} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
