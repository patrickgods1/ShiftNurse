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

import * as Dialog from '@radix-ui/react-dialog';
import type {
  Assignment,
  ExchangeEvaluation,
  ExchangeProposal,
  Id,
  Nurse,
  SchedulePeriod,
  ShiftSwap,
  ShiftType,
} from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import {
  useApproveExchange,
  useCancelExchange,
  useDenyExchange,
  useEvaluateExchange,
  useExchangesForPeriod,
  useProposeExchange,
} from '../../api-exchange.js';
import { AsyncState } from '../../components/async-state.js';
import { type Column, DataTable } from '../../components/data-table.js';
import { formatDateWithWeekday } from '../../format.js';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';
import { nurseLabel } from './decide-dialog.js';
import {
  assignmentOptionLabel,
  buildExchangeProposal,
  type ExchangeFormState,
} from './exchange-proposal.js';
import { ReasonDialog } from './reason-dialog.js';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY, SMALL } from './ui.js';

interface ExchangePanelProps {
  unitId: Id;
  period: SchedulePeriod | undefined;
  nurses: readonly Nurse[];
  assignments: readonly Assignment[];
  nursesById: ReadonlyMap<Id, Nurse>;
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
}

const VERDICT_STYLE: Record<ExchangeEvaluation['verdict'], string> = {
  ok: 'bg-success/15 text-success',
  warn: 'bg-warn/15 text-warn',
  blocked: 'bg-danger/15 text-danger',
};

function VerdictPill({ verdict }: { verdict: ExchangeEvaluation['verdict'] }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${VERDICT_STYLE[verdict]}`}
    >
      {verdict}
    </span>
  );
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

function EvaluationPanel({
  evaluation,
  nursesById,
}: {
  evaluation: ExchangeEvaluation;
  nursesById: ReadonlyMap<Id, Nurse>;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <VerdictPill verdict={evaluation.verdict} />
        {evaluation.verdict === 'ok' ? (
          <span className="text-sm text-text-muted">No hard breach, no warning.</span>
        ) : null}
      </div>
      {evaluation.blockers.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm text-danger">
          {evaluation.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {evaluation.warnings.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm text-warn">
          {evaluation.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <SideImpact
          title={`Requesting · ${nurseLabel(nursesById, evaluation.requesting.nurseId)}`}
          side={evaluation.requesting}
        />
        <SideImpact
          title={`Counterparty · ${nurseLabel(nursesById, evaluation.counterparty.nurseId)}`}
          side={evaluation.counterparty}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-border p-2">
          <p className="text-xs text-text-muted">Unit fairness</p>
          <p className="mt-1">
            {evaluation.fairness.unitScoreBefore.toFixed(0)} →{' '}
            {evaluation.fairness.unitScoreAfter.toFixed(0)}
          </p>
        </div>
        <div className="rounded-md border border-border p-2">
          <p className="text-xs text-text-muted">Unit cost</p>
          <p className="mt-1">
            {formatDollars(evaluation.cost.dollarsBefore)} →{' '}
            {formatDollars(evaluation.cost.dollarsAfter)} (
            {formatSignedDollars(evaluation.cost.delta)})
          </p>
        </div>
      </div>
    </div>
  );
}

function SideImpact({ title, side }: { title: string; side: ExchangeEvaluation['requesting'] }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-xs text-text-muted">{title}</p>
      <p className="mt-1">
        {formatHours(side.hoursBefore)} → {formatHours(side.hoursAfter)}
      </p>
      <p className="text-xs text-text-muted">
        Fairness {side.fairnessBefore.toFixed(0)} → {side.fairnessAfter.toFixed(0)} · Cost{' '}
        {formatDollars(side.dollarsBefore)} → {formatDollars(side.dollarsAfter)}
      </p>
      {side.hardViolations.length > 0 ? (
        <p className="mt-1 text-danger">{side.hardViolations.length} hard violation(s)</p>
      ) : null}
    </div>
  );
}

interface NewExchangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  periodId: Id;
  nurses: readonly Nurse[];
  assignments: readonly Assignment[];
  shiftTypesById: ReadonlyMap<Id, ShiftType>;
}

const EMPTY_FORM: ExchangeFormState = {
  kind: 'giveaway',
  requestingNurseId: '',
  counterpartyNurseId: '',
  offeredAssignmentId: '',
  requestedAssignmentId: '',
};

function NewExchangeDialog({
  open,
  onOpenChange,
  unitId,
  periodId,
  nurses,
  assignments,
  shiftTypesById,
}: NewExchangeDialogProps) {
  const [form, setForm] = useState<ExchangeFormState>(EMPTY_FORM);
  const [reason, setReason] = useState('');
  const propose = useProposeExchange(unitId, periodId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form on each open.
  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setReason('');
    propose.reset();
  }, [open]);

  const nursesById = useMemo(() => new Map(nurses.map((n) => [n.id, n])), [nurses]);
  const requestingAssignments = assignments.filter((a) => a.nurseId === form.requestingNurseId);
  const counterpartyAssignments = assignments.filter((a) => a.nurseId === form.counterpartyNurseId);

  const proposal = useMemo(() => buildExchangeProposal(form), [form]);
  const evaluation = useEvaluateExchange(periodId, proposal);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !propose.isPending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="new-exchange-dialog"
          className="fixed z-50 left-1/2 top-1/2 max-h-[calc(100vh-2rem)] w-[42rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold text-text">New exchange</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Recorded as entered by the manager; a hard-rule breach blocks approval outright.
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!proposal) return;
              propose.mutate(
                { proposal, ...(reason.trim() ? { reason: reason.trim() } : {}) },
                { onSuccess: () => onOpenChange(false) },
              );
            }}
          >
            <fieldset className="flex gap-2 border-0 p-0">
              <legend className="sr-only">Kind</legend>
              {(['giveaway', 'trade'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={form.kind === k}
                  className={`rounded-md border border-border px-3 py-1 text-sm ${
                    form.kind === k ? 'bg-accent text-white' : 'bg-surface text-text hover:bg-bg'
                  }`}
                  onClick={() => setForm((f) => ({ ...f, kind: k, requestedAssignmentId: '' }))}
                >
                  {k === 'giveaway' ? 'Giveaway' : 'Trade'}
                </button>
              ))}
            </fieldset>

            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>
                Requesting nurse
                <select
                  className={INPUT}
                  value={form.requestingNurseId}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      requestingNurseId: e.target.value,
                      offeredAssignmentId: '',
                    }))
                  }
                  required
                >
                  <option value="">Select…</option>
                  {nurses.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.lastName}, {n.firstName}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Their shift to give up
                <select
                  className={INPUT}
                  value={form.offeredAssignmentId}
                  onChange={(e) => setForm((f) => ({ ...f, offeredAssignmentId: e.target.value }))}
                  required
                  disabled={form.requestingNurseId === ''}
                >
                  <option value="">Select…</option>
                  {requestingAssignments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {assignmentOptionLabel(a, shiftTypesById)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                Counterparty nurse
                <select
                  className={INPUT}
                  value={form.counterpartyNurseId}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      counterpartyNurseId: e.target.value,
                      requestedAssignmentId: '',
                    }))
                  }
                  required
                >
                  <option value="">Select…</option>
                  {nurses
                    .filter((n) => n.id !== form.requestingNurseId)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.lastName}, {n.firstName}
                      </option>
                    ))}
                </select>
              </label>
              {form.kind === 'trade' ? (
                <label className={LABEL}>
                  Their shift given back
                  <select
                    className={INPUT}
                    value={form.requestedAssignmentId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, requestedAssignmentId: e.target.value }))
                    }
                    required
                    disabled={form.counterpartyNurseId === ''}
                  >
                    <option value="">Select…</option>
                    {counterpartyAssignments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {assignmentOptionLabel(a, shiftTypesById)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            <label className={LABEL}>
              Reason (optional)
              <textarea
                className={`${INPUT} min-h-16`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>

            {proposal === undefined ? (
              <p className="text-sm text-text-muted">
                Finish picking both sides to see the impact.
              </p>
            ) : evaluation.isPending ? (
              <AsyncState status="loading" label="Evaluating…" />
            ) : evaluation.isError ? (
              <AsyncState status="error" label="Could not evaluate" error={evaluation.error} />
            ) : evaluation.data ? (
              <EvaluationPanel evaluation={evaluation.data} nursesById={nursesById} />
            ) : null}

            {errorMessage(propose.error) !== undefined ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(propose.error)}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={SECONDARY} disabled={propose.isPending}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className={PRIMARY} disabled={propose.isPending || !proposal}>
                {propose.isPending
                  ? 'Recording…'
                  : evaluation.data?.verdict === 'blocked'
                    ? 'Record proposal (blocked)'
                    : 'Record proposal'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface DecideExchangeDialogProps {
  swap: ShiftSwap | undefined;
  unitId: Id;
  periodId: Id | undefined;
  nursesById: ReadonlyMap<Id, Nurse>;
  onClose: () => void;
}

function DecideExchangeDialog({
  swap,
  unitId,
  periodId,
  nursesById,
  onClose,
}: DecideExchangeDialogProps) {
  const open = swap !== undefined;
  const proposal: ExchangeProposal | undefined = swap
    ? {
        kind: swap.kind,
        requestingNurseId: swap.requestingNurseId,
        counterpartyNurseId: swap.counterpartyNurseId,
        offeredAssignmentId: swap.offeredAssignmentId,
        ...(swap.requestedAssignmentId
          ? { requestedAssignmentId: swap.requestedAssignmentId }
          : {}),
      }
    : undefined;
  const evaluation = useEvaluateExchange(periodId, proposal);
  const approve = useApproveExchange(unitId, periodId);
  const deny = useDenyExchange(unitId, periodId);
  const [reason, setReason] = useState('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: fresh swap, fresh form.
  useEffect(() => {
    setReason('');
    approve.reset();
    deny.reset();
  }, [swap?.id]);

  const busy = approve.isPending || deny.isPending;
  const verdict = evaluation.data?.verdict;
  const requiresOverrideReason = verdict === 'warn';
  const canApprove =
    !busy &&
    verdict !== undefined &&
    verdict !== 'blocked' &&
    (!requiresOverrideReason || reason.trim().length > 0);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="decide-exchange-dialog"
          className="fixed z-50 left-1/2 top-1/2 max-h-[calc(100vh-2rem)] w-[42rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          {swap === undefined ? null : (
            <>
              <Dialog.Title className="text-base font-semibold text-text">
                Decide exchange — {nurseLabel(nursesById, swap.requestingNurseId)} →{' '}
                {nurseLabel(nursesById, swap.counterpartyNurseId)}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {swap.kind === 'trade' ? 'Trade' : 'Giveaway'}
                {swap.reason ? ` · "${swap.reason}"` : ''}
              </Dialog.Description>

              {evaluation.isPending ? (
                <AsyncState status="loading" label="Evaluating…" />
              ) : evaluation.isError ? (
                <AsyncState status="error" label="Could not evaluate" error={evaluation.error} />
              ) : evaluation.data ? (
                <EvaluationPanel evaluation={evaluation.data} nursesById={nursesById} />
              ) : null}

              <form
                className="mt-4 flex flex-col gap-3 border-t border-border pt-4"
                onSubmit={(e) => e.preventDefault()}
              >
                <label className={LABEL}>
                  {requiresOverrideReason
                    ? 'Override reason — will be quoted in the audit log'
                    : 'Reason (required to deny; optional on approval)'}
                  <textarea
                    className={`${INPUT} min-h-16`}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="exchange-decision-reason"
                  />
                </label>
                {(errorMessage(approve.error) ?? errorMessage(deny.error)) ? (
                  <p role="alert" className="text-sm text-danger">
                    {errorMessage(approve.error) ?? errorMessage(deny.error)}
                  </p>
                ) : null}
                {verdict === 'blocked' ? (
                  <p className="text-sm text-danger">
                    Blocked — cannot be approved: {evaluation.data?.blockers.join('; ')}
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button type="button" className={SECONDARY} disabled={busy} onClick={onClose}>
                    Close
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-danger px-3 py-1.5 text-sm text-danger hover:bg-bg disabled:opacity-50"
                    disabled={busy || reason.trim().length === 0}
                    onClick={() =>
                      deny.mutate({ id: swap.id, reason: reason.trim() }, { onSuccess: onClose })
                    }
                  >
                    {deny.isPending ? 'Denying…' : 'Deny'}
                  </button>
                  <button
                    type="button"
                    className={PRIMARY}
                    disabled={!canApprove}
                    onClick={() =>
                      approve.mutate(
                        { id: swap.id, ...(reason.trim() ? { reason: reason.trim() } : {}) },
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
