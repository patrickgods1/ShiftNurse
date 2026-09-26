/** Approving or denying a proposed exchange; a `warn` verdict needs an override reason. */

import * as Dialog from '@radix-ui/react-dialog';
import type { ExchangeProposal, Id, Nurse, ShiftSwap } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useApproveExchange, useDenyExchange, useEvaluateExchange } from '../../api-exchange.js';
import { AsyncState } from '../../components/async-state.js';
import { errorMessage, INPUT, LABEL, OVERLAY, PRIMARY, SECONDARY } from '../../components/ui.js';
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
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
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
