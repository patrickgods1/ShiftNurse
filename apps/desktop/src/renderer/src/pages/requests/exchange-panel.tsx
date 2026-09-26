/**
 * Shift exchange: trades and giveaways, judged live against the same rule engine, fairness
 * scorer and cost engine as the grid before anyone commits to one. The evaluation panel is the
 * point of the whole screen — a swap that looks harmless in the queue can turn a Friday night
 * into a Saturday day with six hours' rest, and the manager needs to see that *before* recording
 * it, not after a nurse calls to ask why the schedule changed.
 *
 * Recording a proposal is always allowed, even a blocked one — it puts the ask on the record so
 * "no" has a paper trail too — but approval refuses a blocked swap outright and requires a
 * reason for one that only warns.
 */

import type { Assignment, Id, Nurse, SchedulePeriod, ShiftSwap, ShiftType } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { useCancelExchange, useExchangesForPeriod } from '../../api-exchange.js';
import { AsyncState } from '../../components/async-state.js';
import { type Column, DataTable } from '../../components/data-table.js';
import { PRIMARY, SMALL } from '../../components/ui.js';
import { formatDateWithWeekday } from '../../format.js';
import { nurseLabel } from './decide-dialog.js';
import { DecideExchangeDialog } from './decide-exchange-dialog.js';
import { NewExchangeDialog } from './new-exchange-dialog.js';
import { ReasonDialog } from './reason-dialog.js';

interface ExchangePanelProps {
  unitId: Id;
  period: SchedulePeriod | undefined;
  nurses: readonly Nurse[];
  assignments: readonly Assignment[];
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
}

export function ExchangePanel({
  unitId,
  period,
  nurses,
  assignments,
  nursesById,
  shiftTypesById,
}: ExchangePanelProps) {
  const swapsQuery = useExchangesForPeriod(period?.id);
  const [newOpen, setNewOpen] = useState(false);
  const [deciding, setDeciding] = useState<ShiftSwap | undefined>(undefined);
  const cancel = useCancelExchange(unitId, period?.id);
  const [cancelling, setCancelling] = useState<ShiftSwap | undefined>(undefined);

  const assignmentsById = useMemo(() => new Map(assignments.map((a) => [a.id, a])), [assignments]);

  const columns: Column<ShiftSwap>[] = [
    { key: 'kind', header: 'Kind', render: (s) => (s.kind === 'trade' ? 'Trade' : 'Giveaway') },
    {
      key: 'nurses',
      header: 'Requesting → counterparty',
      render: (s) =>
        `${nurseLabel(nursesById, s.requestingNurseId)} → ${nurseLabel(nursesById, s.counterpartyNurseId)}`,
    },
    {
      key: 'shifts',
      header: 'Shifts',
      render: (s) => {
        const offered = assignmentsById.get(s.offeredAssignmentId);
        const requested = s.requestedAssignmentId
          ? assignmentsById.get(s.requestedAssignmentId)
          : undefined;
        const offeredLabel = offered ? formatDateWithWeekday(offered.date) : s.offeredAssignmentId;
        return requested
          ? `${offeredLabel} ↔ ${formatDateWithWeekday(requested.date)}`
          : offeredLabel;
      },
    },
    { key: 'status', header: 'Status', render: (s) => s.status },
    {
      key: 'actions',
      header: '',
      render: (s) =>
        s.status === 'proposed' ? (
          <span className="flex gap-1">
            <button type="button" className={SMALL} onClick={() => setDeciding(s)}>
              Decide
            </button>
            <button type="button" className={SMALL} onClick={() => setCancelling(s)}>
              Cancel
            </button>
          </span>
        ) : null,
    },
  ];

  return (
    <section aria-labelledby="exchange-heading">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="exchange-heading" className="text-sm font-semibold text-text">
          Exchanges {period ? `· ${period.name}` : ''}
        </h2>
        <button
          type="button"
          className={PRIMARY}
          disabled={period === undefined}
          onClick={() => setNewOpen(true)}
        >
          New exchange
        </button>
      </div>
      {period === undefined ? (
        <AsyncState status="empty" label="Create a scheduling period to propose an exchange." />
      ) : swapsQuery.isPending ? (
        <AsyncState status="loading" label="Loading exchanges" />
      ) : swapsQuery.isError ? (
        <AsyncState status="error" label="Could not load exchanges" error={swapsQuery.error} />
      ) : (
        <DataTable
          columns={columns}
          rows={swapsQuery.data ?? []}
          rowKey={(s) => s.id}
          emptyLabel="No exchanges recorded for this period yet."
        />
      )}

      {period !== undefined ? (
        <NewExchangeDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          unitId={unitId}
          periodId={period.id}
          nurses={nurses}
          assignments={assignments}
          shiftTypesById={shiftTypesById}
        />
      ) : null}
      <DecideExchangeDialog
        swap={deciding}
        unitId={unitId}
        periodId={period?.id}
        nursesById={nursesById}
        onClose={() => setDeciding(undefined)}
      />
      <ReasonDialog
        open={cancelling !== undefined}
        onOpenChange={(next) => !next && setCancelling(undefined)}
        title={cancelling ? 'Cancel exchange' : ''}
        description="Withdraws a proposal that was never decided."
        confirmLabel="Cancel exchange"
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
    </section>
  );
}
