/**
 * Manager-entered time-off request. v1 has no nurse login, so every request arrives on paper,
 * by email or in the corridor and the manager transcribes it here; `enteredBy` is stamped
 * `'manager'` in the repository, which is the seam self-service later plugs into.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id, IsoDate, Nurse, TimeOffType } from '@shiftnurse/core';
import { compareDates, isIsoDate } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useCreateTimeOff } from '../../api-requests.js';
import { DIALOG, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from './ui.js';

const TYPES: { value: TimeOffType; label: string }[] = [
  { value: 'pto', label: 'PTO' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'fmla', label: 'FMLA' },
  { value: 'education', label: 'Education' },
  { value: 'bereavement', label: 'Bereavement' },
];

interface NewRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  periodId: Id | undefined;
  nurses: readonly Nurse[];
}

export function NewRequestDialog({
  open,
  onOpenChange,
  unitId,
  periodId,
  nurses,
}: NewRequestDialogProps) {
  const create = useCreateTimeOff(unitId, periodId);
  const [nurseId, setNurseId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [type, setType] = useState<TimeOffType>('pto');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form on each open.
  useEffect(() => {
    if (!open) return;
    setNurseId('');
    setStart('');
    setEnd('');
    setType('pto');
    setReason('');
    setProblem(undefined);
    create.reset();
  }, [open]);

  const active = nurses.filter((n) => n.active);

  function submit() {
    if (!nurseId) return setProblem('Pick a nurse.');
    if (!isIsoDate(start) || !isIsoDate(end)) return setProblem('Enter both dates.');
    if (compareDates(end, start) < 0) return setProblem('The end date is before the start date.');
    setProblem(undefined);
    create.mutate(
      {
        nurseId,
        startDate: start as IsoDate,
        endDate: end as IsoDate,
        type,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const message = problem ?? errorMessage(create.error);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content data-testid="new-request-dialog" className={`${DIALOG} w-[26rem]`}>
          <Dialog.Title className="text-base font-semibold text-text">
            New time-off request
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-muted">
            Recorded as entered by the manager; it lands in the queue as pending.
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className={LABEL}>
              Nurse
              <select
                className={INPUT}
                value={nurseId}
                onChange={(e) => setNurseId(e.target.value)}
                required
              >
                <option value="">Select…</option>
                {active.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.lastName}, {n.firstName} ({n.role})
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>
                First day off
                <input
                  type="date"
                  className={INPUT}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  required
                />
              </label>
              <label className={LABEL}>
                Last day off
                <input
                  type="date"
                  className={INPUT}
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              </label>
            </div>
            <label className={LABEL}>
              Type
              <select
                className={INPUT}
                value={type}
                onChange={(e) => setType(e.target.value as TimeOffType)}
              >
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Reason (optional)
              <textarea
                className={`${INPUT} min-h-16`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {message !== undefined ? (
              <p role="alert" className="text-sm text-danger">
                {message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={SECONDARY} disabled={create.isPending}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className={PRIMARY} disabled={create.isPending}>
                {create.isPending ? 'Saving…' : 'Add request'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
