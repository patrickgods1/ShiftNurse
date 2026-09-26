/** Entering a trade or giveaway, with the live verdict as the manager fills it in. */

import * as Dialog from '@radix-ui/react-dialog';
import type { Assignment, Id, Nurse, ShiftType } from '@shiftnurse/core';
import { useEffect, useMemo, useState } from 'react';
import { useEvaluateExchange, useProposeExchange } from '../../api-exchange.js';
import { AsyncState } from '../../components/async-state.js';
import { errorMessage, INPUT, LABEL, OVERLAY, PRIMARY, SECONDARY } from '../../components/ui.js';
import { EvaluationPanel } from './exchange-evaluation.js';
import {
  assignmentOptionLabel,
  buildExchangeProposal,
  type ExchangeFormState,
} from './exchange-proposal.js';

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

export function NewExchangeDialog({
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
        <Dialog.Overlay className={OVERLAY} />
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
