/**
 * Requests: the time-off queue, the overlapping-requests calendar, and the period's conflicts.
 *
 * They share a page because they are one decision loop. A manager approves leave against the
 * calendar (who else is already off that weekend?), the approval may open a conflict, and the
 * conflict's ranked resolutions may include denying a *different* pending request — which puts
 * them straight back in the queue. Splitting these across screens would hide exactly the
 * cause-and-effect the milestone exists to surface.
 */

import type { Id, IsoDate, SchedulePeriod, TimeOffRequest, TimeOffStatus } from '@shiftnurse/core';
import { addDays, today } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import { useAssignments, useNurses, usePeriods, useShiftTypes } from '../api.js';
import {
  useCancelTimeOff,
  useConflictPolicy,
  useConflictReport,
  useTimeOffInRange,
  useWithdrawApproval,
} from '../api-requests.js';
import { AsyncState } from '../components/async-state.js';
import { type Column, DataTable } from '../components/data-table.js';
import { PageHeader } from '../components/page-header.js';
import { PRIMARY, SMALL } from '../components/ui.js';
import { defaultPeriod } from '../default-period.js';
import { formatDate } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { ConflictsPanel } from './requests/conflicts-panel.js';
import { DecideDialog, nurseLabel } from './requests/decide-dialog.js';
import { ExchangePanel } from './requests/exchange-panel.js';
import { RequestHeatmap } from './requests/heatmap.js';
import { bucketByDay } from './requests/heatmap-data.js';
import { NewRequestDialog } from './requests/new-request-dialog.js';
import { periodForRequest } from './requests/period-for-request.js';
import { ReasonDialog } from './requests/reason-dialog.js';

type FilterValue = TimeOffStatus | 'all';

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'denied', label: 'Denied' },
  { value: 'all', label: 'All' },
];

/** With no period to anchor on, the calendar shows the next eight weeks from today. */
function fallbackRange(): { start: IsoDate; end: IsoDate } {
  const start = today();
  return { start, end: addDays(start, 8 * 7 - 1) };
}

export default function RequestsPage() {
  const unitId = useUnitId();
  const periodsQuery = usePeriods(unitId);
  const nursesQuery = useNurses(unitId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const periods = periodsQuery.data ?? [];

  const [selectedPeriodId, setSelectedPeriodId] = useState<Id | undefined>(undefined);
  const fallback = useMemo(() => defaultPeriod(periods), [periods]);
  useEffect(() => {
    if (selectedPeriodId === undefined && fallback !== undefined) setSelectedPeriodId(fallback.id);
  }, [selectedPeriodId, fallback]);
  const period: SchedulePeriod | undefined =
    periods.find((p) => p.id === selectedPeriodId) ?? fallback;
  const assignmentsQuery = useAssignments(period?.id);

  const [tab, setTab] = useState<'timeOff' | 'exchanges'>('timeOff');

  const range = useMemo(
    () => (period ? { start: period.startDate, end: period.endDate } : fallbackRange()),
    [period],
  );
  const rangeQuery = useTimeOffInRange(unitId, range.start, range.end);
  const conflictsQuery = useConflictReport(period?.id);
  const policyQuery = useConflictPolicy(unitId);

  const [filter, setFilter] = useState<FilterValue>('pending');
  const [selectedDate, setSelectedDate] = useState<IsoDate | undefined>(undefined);
  const [newOpen, setNewOpen] = useState(false);
  const [reviewing, setReviewing] = useState<TimeOffRequest | undefined>(undefined);
  const [withdrawing, setWithdrawing] = useState<TimeOffRequest | undefined>(undefined);
  const [cancelling, setCancelling] = useState<TimeOffRequest | undefined>(undefined);

  const nursesById = useMemo(
    () => new Map((nursesQuery.data ?? []).map((n) => [n.id, n])),
    [nursesQuery.data],
  );
  const shiftTypesById = useMemo(
    () => new Map((shiftTypesQuery.data ?? []).map((s) => [s.id, s])),
    [shiftTypesQuery.data],
  );

  const days = useMemo(
    () => bucketByDay(rangeQuery.data ?? [], range.start, range.end),
    [rangeQuery.data, range],
  );
  const onSelectedDay = useMemo(
    () => new Set(days.find((d) => d.date === selectedDate)?.requestIds ?? []),
    [days, selectedDate],
  );

  const rows = useMemo(() => {
    const all = rangeQuery.data ?? [];
    return all
      .filter((r) => filter === 'all' || r.status === filter)
      .filter((r) => selectedDate === undefined || onSelectedDay.has(r.id))
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
  }, [rangeQuery.data, filter, selectedDate, onSelectedDay]);

  const decidingPeriod = reviewing ? periodForRequest(periods, reviewing) : undefined;
  const withdraw = useWithdrawApproval(
    unitId,
    withdrawing ? periodForRequest(periods, withdrawing)?.id : undefined,
  );
  const cancel = useCancelTimeOff(
    unitId,
    cancelling ? periodForRequest(periods, cancelling)?.id : undefined,
  );

  const columns: Column<TimeOffRequest>[] = [
    {
      key: 'nurse',
      header: 'Nurse',
      render: (r) => nurseLabel(nursesById, r.nurseId),
      sortValue: (r) => nurseLabel(nursesById, r.nurseId).toLowerCase(),
    },
    {
      key: 'dates',
      header: 'Dates',
      render: (r) => `${formatDate(r.startDate)} – ${formatDate(r.endDate)}`,
      sortValue: (r) => r.startDate,
    },
    { key: 'type', header: 'Type', render: (r) => r.type },
    { key: 'status', header: 'Status', render: (r) => r.status },
    {
      key: 'reason',
      header: 'Reason',
      render: (r) => (r.status === 'denied' ? (r.decisionReason ?? '') : (r.reason ?? '')),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        r.status === 'pending' ? (
          <span className="flex gap-1">
            <button
              type="button"
              className={SMALL}
              data-testid="review-request"
              onClick={() => setReviewing(r)}
            >
              Review
            </button>
            <button type="button" className={SMALL} onClick={() => setCancelling(r)}>
              Cancel
            </button>
          </span>
        ) : r.status === 'approved' ? (
          <button type="button" className={SMALL} onClick={() => setWithdrawing(r)}>
            Withdraw approval
          </button>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Requests"
        description="Time off, who else is off, and what the schedule can't yet cover"
        actions={
          <>
            {periods.length > 0 ? (
              <select
                aria-label="Period"
                value={period?.id ?? ''}
                onChange={(e) => setSelectedPeriodId(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text"
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {formatDate(p.startDate)} – {formatDate(p.endDate)}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className={PRIMARY}
              data-testid="new-request"
              onClick={() => setNewOpen(true)}
            >
              New request
            </button>
          </>
        }
      />

      <fieldset className="mb-6 flex gap-2 border-0 p-0">
        <legend className="sr-only">Requests or exchanges</legend>
        {(
          [
            { value: 'timeOff', label: 'Time off' },
            { value: 'exchanges', label: 'Exchanges' },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={tab === option.value}
            className={`rounded-md border border-border px-3 py-1.5 text-sm font-medium ${
              tab === option.value ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
            }`}
            onClick={() => setTab(option.value)}
          >
            {option.label}
          </button>
        ))}
      </fieldset>

      {tab === 'exchanges' ? (
        <ExchangePanel
          unitId={unitId}
          period={period}
          nurses={nursesQuery.data ?? []}
          assignments={assignmentsQuery.data ?? []}
          nursesById={nursesById}
          shiftTypesById={shiftTypesById}
        />
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)] gap-6">
            <section aria-labelledby="queue-heading">
              <div className="mb-3 flex items-center gap-3">
                <h2 id="queue-heading" className="text-sm font-semibold text-text">
                  Queue
                </h2>
                <fieldset className="flex gap-2 border-0 p-0">
                  <legend className="sr-only">Filter by status</legend>
                  {FILTERS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={filter === option.value}
                      className={`rounded-md border border-border px-3 py-1 text-sm ${
                        filter === option.value
                          ? 'bg-accent text-white'
                          : 'bg-surface text-text hover:bg-bg'
                      }`}
                      onClick={() => setFilter(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </fieldset>
                {selectedDate !== undefined ? (
                  <button
                    type="button"
                    className={SMALL}
                    onClick={() => setSelectedDate(undefined)}
                  >
                    Touching {formatDate(selectedDate)} · clear
                  </button>
                ) : null}
              </div>
              {rangeQuery.isPending || nursesQuery.isPending ? (
                <AsyncState status="loading" label="Loading requests" />
              ) : rangeQuery.isError ? (
                <AsyncState
                  status="error"
                  label="Could not load requests"
                  error={rangeQuery.error}
                />
              ) : (
                <DataTable
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => r.id}
                  emptyLabel={
                    selectedDate !== undefined
                      ? 'No requests touch that day.'
                      : `No ${filter === 'all' ? '' : `${filter} `}requests between ${formatDate(range.start)} and ${formatDate(range.end)}.`
                  }
                />
              )}
            </section>

            <section
              aria-labelledby="heatmap-heading"
              className="rounded-md border border-border bg-surface p-4"
            >
              <h2 id="heatmap-heading" className="mb-2 text-sm font-semibold text-text">
                Who is off · {formatDate(range.start)} – {formatDate(range.end)}
              </h2>
              {rangeQuery.isPending ? (
                <AsyncState status="loading" label="Loading calendar" />
              ) : (
                <RequestHeatmap
                  days={days}
                  selectedDate={selectedDate}
                  onSelectDate={setSelectedDate}
                />
              )}
            </section>
          </div>

          <div className="mt-8">
            {period === undefined ? (
              <AsyncState
                status="empty"
                label="Create a scheduling period to see its conflicts here."
              />
            ) : conflictsQuery.isPending ? (
              <AsyncState status="loading" label="Analysing the period…" />
            ) : conflictsQuery.isError ? (
              <AsyncState
                status="error"
                label="Could not analyse the period"
                error={conflictsQuery.error}
              />
            ) : (
              <ConflictsPanel
                unitId={unitId}
                period={period}
                report={conflictsQuery.data}
                policy={policyQuery.data}
                nursesById={nursesById}
              />
            )}
          </div>
        </>
      )}

      <NewRequestDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        unitId={unitId}
        periodId={period?.id}
        nurses={nursesQuery.data ?? []}
      />
      <DecideDialog
        request={reviewing}
        period={decidingPeriod}
        unitId={unitId}
        nursesById={nursesById}
        shiftTypesById={shiftTypesById}
        onClose={() => setReviewing(undefined)}
      />
      <ReasonDialog
        open={withdrawing !== undefined}
        onOpenChange={(next) => !next && setWithdrawing(undefined)}
        title={
          withdrawing ? `Withdraw approval — ${nurseLabel(nursesById, withdrawing.nurseId)}` : ''
        }
        description="The nurse may already have made plans around this approval. The reason is recorded and quoted if challenged."
        confirmLabel="Withdraw approval"
        destructive
        pending={withdraw.isPending}
        error={withdraw.error}
        onConfirm={(reason) => {
          if (!withdrawing) return;
          withdraw.mutate(
            { id: withdrawing.id, reason },
            { onSuccess: () => setWithdrawing(undefined) },
          );
        }}
      />
      <ReasonDialog
        open={cancelling !== undefined}
        onOpenChange={(next) => !next && setCancelling(undefined)}
        title={cancelling ? `Cancel request — ${nurseLabel(nursesById, cancelling.nurseId)}` : ''}
        description="Withdraws a request that was never decided, on the nurse's behalf."
        confirmLabel="Cancel request"
        required={false}
        pending={cancel.isPending}
        error={cancel.error}
        onConfirm={(reason) => {
          if (!cancelling) return;
          cancel.mutate(
            { id: cancelling.id, ...(reason ? { reason } : {}) },
            { onSuccess: () => setCancelling(undefined) },
          );
        }}
      />
    </div>
  );
}
