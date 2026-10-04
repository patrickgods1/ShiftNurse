/**
 * Approve or deny with the consequences on screen first. The what-if runs against the period
 * the request falls in: which of the nurse's shifts approval would orphan, how far coverage
 * moves, which conflicts appear or clear, and who else is asking for the same days. Deny needs
 * a reason before the button enables — the repository refuses without one, so the form says so
 * up front rather than after a round trip.
 *
 * Read top to bottom the way a manager decides: can the unit spare this nurse on those days
 * (capacity, judged without the draft, so it means the same before and after Generate); then,
 * if the draft already has them working, who takes each freed shift — "Approve and cover" does
 * the approval and the cover in one step instead of regenerating the whole schedule.
 */

import type { LeaveCoverOption } from '@shared/api.js';
import type {
  CapacityVerdict,
  Conflict,
  DayCapacity,
  Id,
  Nurse,
  SchedulePeriod,
  ShiftType,
  TimeOffImpact,
  TimeOffRequest,
} from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import {
  useApproveAndCover,
  useApproveTimeOff,
  useCoverOptions,
  useDenyTimeOff,
  useTimeOffImpact,
} from '../../api-requests.js';
import { AsyncState } from '../../components/async-state.js';
import { Modal } from '../../components/modal.js';
import { DANGER, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../../components/ui.js';
import { formatDate, formatDateWithWeekday, periodLabel } from '../../format.js';

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
  const coverQuery = useCoverOptions(period?.id, request?.id);
  const approveAndCover = useApproveAndCover(unitId, period?.id);
  const [reason, setReason] = useState('');
  /** assignment id → the nurse picked to cover it; '' leaves the shift open. */
  const [covers, setCovers] = useState<Record<Id, Id | ''>>({});
  const options = coverQuery.data ?? [];
  // Best candidate pre-selected for each freed shift, as soon as the options arrive.
  useEffect(() => {
    setCovers(
      Object.fromEntries(
        (coverQuery.data ?? []).map((o) => [o.assignment.id, o.candidates[0]?.nurseId ?? '']),
      ),
    );
  }, [coverQuery.data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh request, fresh form.
  useEffect(() => {
    setReason('');
    approve.reset();
    deny.reset();
    approveAndCover.reset();
  }, [request?.id]);

  const busy = approve.isPending || deny.isPending || approveAndCover.isPending;
  const error =
    errorMessage(approve.error) ?? errorMessage(deny.error) ?? errorMessage(approveAndCover.error);
  const freesShifts = period !== undefined && options.length > 0;
  // Taking shifts off a published schedule is a change staff will hear about: it needs a reason.
  const needsReason = freesShifts && period?.status === 'published';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      data-testid="decide-dialog"
      size="lg"
      title={
        request === undefined ? '' : <>Review request — {nurseLabel(nursesById, request.nurseId)}</>
      }
      description={
        request === undefined ? undefined : (
          <>
            {request.type.toUpperCase()} · {formatDateWithWeekday(request.startDate)} –{' '}
            {formatDateWithWeekday(request.endDate)}
            {request.reason ? ` · “${request.reason}”` : ''}
          </>
        )
      }
    >
      {request === undefined ? null : (
        <>
          <section className="mt-4" aria-label="Projected impact of approving">
            <h3 className="text-sm font-semibold text-text">If approved</h3>
            {period === undefined ? (
              <p className="mt-1 text-sm text-text-muted">
                No scheduling period covers these dates yet, so there is no staffing impact to show.
                The request can still be decided.
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
                options={options}
                covers={covers}
                onCover={(assignmentId, nurseId) =>
                  setCovers((prev) => ({ ...prev, [assignmentId]: nurseId }))
                }
              />
            )}
          </section>

          <form
            className="mt-4 flex flex-col gap-3 border-t border-border pt-4"
            onSubmit={(e) => e.preventDefault()}
          >
            <label className={LABEL}>
              {needsReason
                ? 'Reason (required: staff already hold this schedule)'
                : 'Reason for denial (required to deny; optional note on approval)'}
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
                disabled={busy || (needsReason && reason.trim().length === 0)}
                onClick={() => {
                  const note = reason.trim() ? { reason: reason.trim() } : {};
                  if (freesShifts) {
                    approveAndCover.mutate(
                      {
                        id: request.id,
                        ...note,
                        covers: Object.entries(covers)
                          .filter(([, nurseId]) => nurseId !== '')
                          .map(([assignmentId, nurseId]) => ({
                            assignmentId,
                            nurseId: nurseId as Id,
                          })),
                      },
                      { onSuccess: onClose },
                    );
                  } else {
                    approve.mutate({ id: request.id, ...note }, { onSuccess: onClose });
                  }
                }}
              >
                {approve.isPending || approveAndCover.isPending
                  ? 'Approving…'
                  : freesShifts
                    ? 'Approve and cover'
                    : 'Approve'}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

const VERDICT: Record<CapacityVerdict, { label: string; tone: string }> = {
  ok: { label: 'Can spare', tone: 'bg-success/15 text-success' },
  tight: {
    label: 'Tight — a shift or more extra from per-diem or overtime',
    tone: 'bg-warn/15 text-warn',
  },
  short: { label: 'Short — more than per-diem staff can fill', tone: 'bg-danger/15 text-danger' },
};

function CapacityView({ days }: { days: readonly DayCapacity[] }) {
  if (days.length === 0) {
    return <p className="mt-1 text-text-muted">No staffing floor falls on these days.</p>;
  }
  return (
    <ul className="mt-1 flex flex-col gap-1.5" data-testid="leave-capacity">
      {days.map((d) => (
        <li key={`${d.date}:${d.role}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-text">
            {formatDateWithWeekday(d.date)} · {d.role}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT[d.verdict].tone}`}
          >
            {VERDICT[d.verdict].label}
          </span>
          <span className="w-full text-xs text-text-muted">
            {d.needed} shifts needed; staff not on leave cover about {d.supply} at their contracted
            hours (about {d.usualSupply} on a day nobody is off)
            {d.perDiem > 0 ? `, plus ${d.perDiem} per-diem` : ''}. Already off: {d.offApproved}{' '}
            approved{d.offPending > 0 ? `, ${d.offPending} more asking` : ''}.
            {d.verdictIfAllApproved !== d.verdict
              ? ` If the other requests that day are approved too: ${VERDICT[d.verdictIfAllApproved].label.toLowerCase()}.`
              : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ImpactView({
  impact,
  period,
  nursesById,
  shiftTypesById,
  options,
  covers,
  onCover,
}: {
  impact: TimeOffImpact;
  period: SchedulePeriod;
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  options: readonly LeaveCoverOption[];
  covers: Readonly<Record<Id, Id | ''>>;
  onCover: (assignmentId: Id, nurseId: Id | '') => void;
}) {
  // A pending-overlap warning that names only this request is not something deciding it
  // "clears": it was a warning about this very request.
  const cleared = impact.cleared.filter(
    (c) =>
      !(c.kind === 'competing_time_off' && c.timeOffIds.every((id) => id === impact.request.id)),
  );
  return (
    <div className="mt-2 flex flex-col gap-3 text-sm">
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Can the unit spare them on these days?</p>
        <CapacityView days={impact.capacity} />
      </div>
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">
          Shifts this frees on {periodLabel(period)}
          {period.status === 'published' ? ' (published: staff will be told)' : ''}
        </p>
        {options.length === 0 ? (
          <p className="mt-1 text-text-muted">
            {impact.displacedAssignments.length === 0
              ? 'Not scheduled on these days: nothing to cover.'
              : 'Loading who could cover…'}
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {options.map((o) => (
              <li key={o.assignment.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-56 text-text">
                  {formatDateWithWeekday(o.assignment.date)} ·{' '}
                  {shiftTypesById.get(o.assignment.shiftTypeId)?.name ?? o.assignment.shiftTypeId}
                  {o.assignment.isCharge ? ' (charge)' : ''}
                </span>
                <select
                  className={INPUT}
                  aria-label={`Who covers ${formatDateWithWeekday(o.assignment.date)}`}
                  data-testid="cover-pick"
                  value={covers[o.assignment.id] ?? ''}
                  onChange={(e) => onCover(o.assignment.id, e.target.value)}
                >
                  {o.candidates.map((c) => (
                    <option key={c.nurseId} value={c.nurseId}>
                      {c.label}
                      {c.overtime ? ' — overtime' : c.payTier === 'agency' ? ' — agency' : ''}
                    </option>
                  ))}
                  <option value="">Leave it open for now</option>
                </select>
                {o.candidates.length === 0 ? (
                  <span className="text-xs text-danger">Nobody can legally take it.</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ConflictList title="New problems if approved" items={impact.introduced} tone="danger" />
        <ConflictList title="Problems it settles" items={cleared} tone="success" />
      </div>
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Others asking for these days</p>
        {impact.competing.length === 0 ? (
          <p className="mt-1 text-text-muted">Nobody else is asking for these days.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {impact.competing.map((r) => (
              <li key={r.id}>
                {nurseLabel(nursesById, r.nurseId)} · {formatDate(r.startDate)} –{' '}
                {formatDate(r.endDate)} · {r.type.toUpperCase()}
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
