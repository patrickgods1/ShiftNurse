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
 *
 * Approval waits for the cover options: until they arrive the dialog cannot tell a plain
 * approval from one that takes shifts off a posted schedule.
 */

import type { LeaveCoverOption } from '@shared/api.js';
import {
  type CapacityVerdict,
  type Conflict,
  type DayCapacity,
  type Id,
  type Nurse,
  type SchedulePeriod,
  type ShiftType,
  TIME_OFF_TYPE_LABELS,
  type TimeOffImpact,
  type TimeOffRequest,
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
import { CompetingAdvice, nurseLabel } from './competing-advice.js';
import { LeaveStanding } from './leave-standing.js';

interface DecideDialogProps {
  request: TimeOffRequest | undefined;
  period: SchedulePeriod | undefined;
  /**
   * The unit's periods, to name and judge each one whose shifts approval frees: a request that
   * spans a published period and the next draft frees shifts on both.
   */
  periods: readonly SchedulePeriod[];
  unitId: Id;
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  /**
   * The period's conflicts, for the equity advice on competing requests. `TimeOffImpact.cleared`
   * would only hold them when this one decision clears the conflict, so the page passes them in.
   */
  conflicts?: readonly Conflict[];
  onClose: () => void;
}

// Lives in competing-advice.tsx so that file need not import this one; re-exported for callers.
export { nurseLabel };

export function DecideDialog({
  request,
  period,
  periods,
  unitId,
  nursesById,
  shiftTypesById,
  conflicts = [],
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
  // Declared before the seeding effect below: when a cached cover list arrives on the same
  // render as a new request, the form clears first and is then seeded, not the other way round.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh request, fresh form.
  useEffect(() => {
    setCovers({});
    setReason('');
    approve.reset();
    deny.reset();
    approveAndCover.reset();
  }, [request?.id]);

  // Best candidate pre-selected for each freed shift, as soon as the options arrive. A refetch
  // (any schedule write refreshes the list) keeps the manager's pick while it is still offered.
  useEffect(() => {
    const data = coverQuery.data;
    if (data === undefined) return;
    setCovers((prev) =>
      Object.fromEntries(
        data.map((o) => {
          const kept = prev[o.assignment.id];
          const stillOffered = kept === '' || o.candidates.some((c) => c.nurseId === kept);
          return [
            o.assignment.id,
            kept !== undefined && stillOffered ? kept : (o.candidates[0]?.nurseId ?? ''),
          ];
        }),
      ),
    );
  }, [coverQuery.data]);

  const busy = approve.isPending || deny.isPending || approveAndCover.isPending;
  const error =
    errorMessage(approve.error) ?? errorMessage(deny.error) ?? errorMessage(approveAndCover.error);
  // No period means nothing to free; otherwise a pending or failed lookup must not read as "no
  // options", or the plain approval would leave posted shifts rostered during approved leave.
  const coverReady = period === undefined || coverQuery.isSuccess;
  const freesShifts = coverReady && period !== undefined && options.length > 0;
  const periodsById = new Map(periods.map((p) => [p.id, p]));
  if (period !== undefined) periodsById.set(period.id, period);
  // Taking shifts off a published schedule is a change staff will hear about: it needs a reason,
  // whichever of the periods the request touches that schedule is.
  const needsReason =
    freesShifts &&
    options.some((o) => periodsById.get(o.assignment.periodId)?.status === 'published');

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
            {TIME_OFF_TYPE_LABELS[request.type]} · {formatDateWithWeekday(request.startDate)} –{' '}
            {formatDateWithWeekday(request.endDate)}
            {request.reason ? ` · “${request.reason}”` : ''}
          </>
        )
      }
    >
      {request === undefined ? null : (
        <>
          <section className="mt-4" aria-label="Leave balance">
            <LeaveStanding
              nurseId={request.nurseId}
              type={request.type}
              start={request.startDate}
              end={request.endDate}
              paidHours={request.paidHours ?? 0}
            />
          </section>

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
                periodsById={periodsById}
                nursesById={nursesById}
                shiftTypesById={shiftTypesById}
                conflicts={conflicts}
                options={options}
                cover={{
                  status: coverQuery.status,
                  error: coverQuery.error,
                  retry: () => void coverQuery.refetch(),
                }}
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
            {coverQuery.isError ? (
              <p className="text-sm text-text-muted">
                Approval waits until the dialog knows which shifts it frees.
              </p>
            ) : null}
            {error !== undefined ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
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
                disabled={busy || !coverReady || (needsReason && reason.trim().length === 0)}
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
                  : coverQuery.isPending && period !== undefined
                    ? 'Checking who could cover…'
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
  periodsById,
  nursesById,
  shiftTypesById,
  conflicts,
  options,
  cover,
  covers,
  onCover,
}: {
  impact: TimeOffImpact;
  period: SchedulePeriod;
  periodsById: ReadonlyMap<Id, SchedulePeriod>;
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
  conflicts: readonly Conflict[];
  options: readonly LeaveCoverOption[];
  cover: { status: 'pending' | 'error' | 'success'; error: unknown; retry: () => void };
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
      <CompetingAdvice
        conflicts={conflicts}
        requestId={impact.request.id}
        nursesById={nursesById}
      />
      <div className="rounded-md border border-border p-3">
        <p className="text-xs text-text-muted">Can the unit spare them on these days?</p>
        <CapacityView days={impact.capacity} />
      </div>
      {cover.status === 'pending' ? (
        <div className="rounded-md border border-border p-3">
          <FreedHeading period={period} />
          <AsyncState status="loading" label="Checking who could cover…" />
        </div>
      ) : cover.status === 'error' ? (
        <div className="rounded-md border border-border p-3">
          <FreedHeading period={period} />
          <AsyncState status="error" label="Could not find who could cover" error={cover.error} />
          <button type="button" className={`${SECONDARY} mt-2`} onClick={cover.retry}>
            Try again
          </button>
        </div>
      ) : options.length === 0 ? (
        <div className="rounded-md border border-border p-3">
          <FreedHeading period={period} />
          <p className="mt-1 text-text-muted">Not scheduled on these days: nothing to cover.</p>
        </div>
      ) : (
        groupByPeriod(options).map(([periodId, group]) => (
          <div key={periodId} className="rounded-md border border-border p-3">
            <FreedHeading period={periodsById.get(periodId)} />
            <ul className="mt-1 flex flex-col gap-2">
              {group.map((o) => (
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
          </div>
        ))
      )}
      <div className="grid grid-cols-2 gap-3">
        <ConflictList
          title="New problems if approved"
          items={[
            ...impact.introduced,
            ...impact.worsened.map((w) => ({
              ...w.after,
              message: `Worse than now: ${w.after.message}`,
            })),
          ]}
          tone="danger"
        />
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
                {formatDate(r.endDate)} · {TIME_OFF_TYPE_LABELS[r.type]}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A period id the page does not list still gets a heading rather than an id. */
function FreedHeading({ period }: { period: SchedulePeriod | undefined }) {
  return (
    <p className="text-xs text-text-muted">
      {period === undefined
        ? 'Shifts this frees on another schedule'
        : `Shifts this frees on ${periodLabel(period)}${
            period.status === 'published' ? ' (published: staff will be told)' : ''
          }`}
    </p>
  );
}

/** Options in main's order (the anchor period first), one group per period. */
function groupByPeriod(options: readonly LeaveCoverOption[]): [Id, LeaveCoverOption[]][] {
  const groups = new Map<Id, LeaveCoverOption[]>();
  for (const o of options) {
    groups.set(o.assignment.periodId, [...(groups.get(o.assignment.periodId) ?? []), o]);
  }
  return [...groups];
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
