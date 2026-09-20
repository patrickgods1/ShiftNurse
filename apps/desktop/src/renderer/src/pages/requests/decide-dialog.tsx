/**
 * Approve or deny with the consequences on screen first. The what-if runs against the period
 * the request falls in: which of the nurse's shifts approval would orphan, how far coverage
 * moves, which conflicts appear or clear, and who else is asking for the same days. Deny needs
 * a reason before the button enables — the repository refuses without one, so the form says so
 * up front rather than after a round trip.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type {
  Conflict,
  Id,
  Nurse,
  SchedulePeriod,
  ShiftType,
  TimeOffImpact,
  TimeOffRequest,
} from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useApproveTimeOff, useDenyTimeOff, useTimeOffImpact } from '../../api-requests.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDate, formatDateWithWeekday } from '../../format.js';
import { DANGER, DIALOG, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from './ui.js';

interface DecideDialogProps {
  request: TimeOffRequest | undefined;
  period: SchedulePeriod | undefined;
  unitId: Id;
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  onClose: () => void;
}

export function nurseLabel(nursesById: ReadonlyMap<Id, Nurse>, id: Id): string {
  const n = nursesById.get(id);
  return n ? `${n.firstName} ${n.lastName}` : id;
}

export function DecideDialog({
  request,
  period,
  unitId,
  nursesById,
  shiftTypesById,
  onClose,
}: DecideDialogProps) {
  const open = request !== undefined;
  const impactQuery = useTimeOffImpact(period?.id, request?.id, 'approved');
  const approve = useApproveTimeOff(unitId, period?.id);
  const deny = useDenyTimeOff(unitId, period?.id);
  const [reason, setReason] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh request, fresh form.
  useEffect(() => {
    setReason('');
    approve.reset();
    deny.reset();
  }, [request?.id]);

  const busy = approve.isPending || deny.isPending;
  const error = errorMessage(approve.error) ?? errorMessage(deny.error);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content data-testid="decide-dialog" className={`${DIALOG} w-[40rem]`}>
          {request === undefined ? null : (
            <>
              <Dialog.Title className="text-base font-semibold text-text">
                Review request — {nurseLabel(nursesById, request.nurseId)}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {request.type.toUpperCase()} · {formatDateWithWeekday(request.startDate)} –{' '}
                {formatDateWithWeekday(request.endDate)}
                {request.reason ? ` · “${request.reason}”` : ''}
              </Dialog.Description>

              <section className="mt-4" aria-label="Projected impact of approving">
                <h3 className="text-sm font-semibold text-text">If approved</h3>
                {period === undefined ? (
                  <p className="mt-1 text-sm text-text-muted">
                    No scheduling period covers these dates yet, so there is no staffing impact to
                    show. The request can still be decided.
                  </p>
                ) : impactQuery.isPending ? (
                  <AsyncState status="loading" label="Simulating the approval…" />
                ) : impactQuery.isError ? (
                  <AsyncState status="error" label="Could not simulate" error={impactQuery.error} />
                ) : (
                  <ImpactView
                    impact={impactQuery.data}
                    period={period}
                    nursesById={nursesById}
                    shiftTypesById={shiftTypesById}
                  />
                )}
              </section>

              <form
                className="mt-4 flex flex-col gap-3 border-t border-border pt-4"
                onSubmit={(e) => e.preventDefault()}
              >
                <label className={LABEL}>
                  Reason for denial (required to deny; optional note on approval)
                  <textarea
                    className={`${INPUT} min-h-16`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="decision-reason"
                  />
                </label>
                {error !== undefined ? (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button type="button" className={SECONDARY} disabled={busy} onClick={onClose}>
                    Close
                  </button>
                  <button
                    type="button"
                    className={DANGER}
                    data-testid="deny-request"
                    disabled={busy || reason.trim().length === 0}
                    onClick={() =>
                      deny.mutate({ id: request.id, reason: reason.trim() }, { onSuccess: onClose })
                    }
                  >
                    {deny.isPending ? 'Denying…' : 'Deny'}
                  </button>
                  <button
                    type="button"
                    className={PRIMARY}
                    data-testid="approve-request"
                    disabled={busy}
                    onClick={() =>
                      approve.mutate(
                        { id: request.id, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                        { onSuccess: onClose },
                      )
                    }
                  >
                    {approve.isPending ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </form>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImpactView({
  impact,
  period,
  nursesById,
  shiftTypesById,
}: {
  impact: TimeOffImpact;
  period: SchedulePeriod;
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
}) {
  const delta = impact.coverage.delta;
  return (
    <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Coverage · {period.name}</p>
        <p className={`mt-1 text-lg font-semibold ${delta > 0 ? 'text-danger' : 'text-text'}`}>
          {delta > 0 ? `+${delta}` : delta} slot{Math.abs(delta) === 1 ? '' : 's'} short
        </p>
        <p className="text-xs text-text-muted">
          {impact.coverage.hardShortfallBefore} → {impact.coverage.hardShortfallAfter} below a hard
          minimum
        </p>
      </div>
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Shifts lifted from the draft on approval</p>
        {impact.displacedAssignments.length === 0 ? (
          <p className="mt-1 text-text-muted">None scheduled in the range.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {impact.displacedAssignments.map((a) => (
              <li key={a.id}>
                {formatDateWithWeekday(a.date)} ·{' '}
                {shiftTypesById.get(a.shiftTypeId)?.name ?? a.shiftTypeId}
                {a.isCharge ? ' (charge)' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ConflictList title="Conflicts introduced" items={impact.introduced} tone="danger" />
      <ConflictList title="Conflicts cleared" items={impact.cleared} tone="success" />
      <div className="col-span-2 rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Competing pending requests on these dates</p>
        {impact.competing.length === 0 ? (
          <p className="mt-1 text-text-muted">Nobody else is asking for these days.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {impact.competing.map((r) => (
              <li key={r.id}>
                {nurseLabel(nursesById, r.nurseId)} · {formatDate(r.startDate)} –{' '}
                {formatDate(r.endDate)} · {r.type}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConflictList({
  title,
  items,
  tone,
}: {
  title: string;
  items: readonly Conflict[];
  tone: 'danger' | 'success';
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-text-muted">
        {title}{' '}
        <span className={tone === 'danger' ? 'text-danger' : 'text-success'}>({items.length})</span>
      </p>
      {items.length === 0 ? (
        <p className="mt-1 text-text-muted">None.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {items.map((c) => (
            <li key={c.id}>
              <span
                className={`mr-1 rounded px-1 text-[10px] uppercase ${
                  c.severity === 'hard' ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'
                }`}
              >
                {c.severity}
              </span>
              {c.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
