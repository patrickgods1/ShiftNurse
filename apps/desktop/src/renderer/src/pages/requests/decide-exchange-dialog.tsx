/** Approving or denying a proposed exchange; a `warn` verdict needs an override reason. */

import type { ExchangeProposal, Id, Nurse, ShiftSwap } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useApproveExchange, useDenyExchange, useEvaluateExchange } from '../../api-exchange.js';
import { AsyncState } from '../../components/async-state.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../../components/ui.js';
import { nurseLabel } from './decide-dialog.js';
import { EvaluationPanel } from './exchange-evaluation.js';

interface DecideExchangeDialogProps {
  swap: ShiftSwap | undefined;
  unitId: Id;
  periodId: Id | undefined;
  nursesById: ReadonlyMap<Id, Nurse>;
  onClose: () => void;
}

export function DecideExchangeDialog({
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
    <Modal
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      data-testid="decide-exchange-dialog"
      size="lg"
      title={
        swap === undefined ? (
          ''
        ) : (
          <>
            Decide exchange — {nurseLabel(nursesById, swap.requestingNurseId)} →{' '}
            {nurseLabel(nursesById, swap.counterpartyNurseId)}
          </>
        )
      }
      description={
        swap === undefined ? undefined : (
          <>
            {swap.kind === 'trade' ? 'Trade' : 'Giveaway'}
            {swap.reason ? ` · "${swap.reason}"` : ''}
          </>
        )
      }
    >
      {swap === undefined ? null : (
        <>
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
    </Modal>
  );
}
