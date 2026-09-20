/**
 * Creates a new scheduling period (name + date range). Everything else on a period —
 * assignments, the rule-set snapshot — comes from the schedule engine once shifts start landing
 * on the grid, so this form stays deliberately small.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { Id, IsoDate, SchedulePeriod } from '@shiftnurse/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useCreatePeriod } from '../../api-schedule.js';

interface NewPeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  onCreated: (period: SchedulePeriod) => void;
}

export function NewPeriodDialog({ open, onOpenChange, unitId, onCreated }: NewPeriodDialogProps) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const formId = useId();
  const createPeriod = useCreatePeriod(unitId);

  // Reset on every open, same rationale as NurseFormDialog: `createPeriod` is a fresh object
  // each render, so depending on it would re-run this every render instead of only on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    if (!open) return;
    setName('');
    setStartDate('');
    setEndDate('');
    setError(undefined);
    createPeriod.reset();
  }, [open]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!startDate || !endDate) {
      setError('Start and end dates are required.');
      return;
    }
    if (startDate > endDate) {
      setError('End date must be on or after the start date.');
      return;
    }
    setError(undefined);
    createPeriod.mutate(
      { name: name.trim(), startDate: startDate as IsoDate, endDate: endDate as IsoDate },
      {
        onSuccess: (period) => {
          onCreated(period);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-lg
            border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">New period</Dialog.Title>
          <form id={formId} data-testid="new-period-form" onSubmit={handleSubmit} noValidate>
            <label className="block text-sm text-text-muted" htmlFor={`${formId}-name`}>
              Name
              <input
                id={`${formId}-name`}
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-sm text-text-muted" htmlFor={`${formId}-start`}>
                Start date
                <input
                  id={`${formId}-start`}
                  type="date"
                  className={inputClass}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <label className="block text-sm text-text-muted" htmlFor={`${formId}-end`}>
                End date
                <input
                  id={`${formId}-end`}
                  type="date"
                  className={inputClass}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>
            </div>
            {error !== undefined ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            {createPeriod.error !== null && createPeriod.error !== undefined ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {createPeriod.error instanceof Error
                  ? createPeriod.error.message
                  : String(createPeriod.error)}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                data-testid="new-period-save"
                disabled={createPeriod.isPending}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                  disabled:opacity-60"
              >
                {createPeriod.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text ' +
  'focus-visible:border-accent';
