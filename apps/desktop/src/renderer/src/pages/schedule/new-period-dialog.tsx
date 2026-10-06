/**
 * Creates a new scheduling period (name + date range). Everything else on a period —
 * assignments, the rule-set snapshot — comes from the schedule engine once shifts start landing
 * on the grid, so this form stays deliberately small.
 */

import { addDays, type Id, type IsoDate, type SchedulePeriod } from '@shiftnurse/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useCreatePeriod } from '../../api-schedule.js';
import { DateField } from '../../components/date-field.js';
import { Modal } from '../../components/modal.js';
import { PRIMARY, SECONDARY } from '../../components/ui.js';

interface NewPeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  onCreated: (period: SchedulePeriod) => void;
}

export function NewPeriodDialog({ open, onOpenChange, unitId, onCreated }: NewPeriodDialogProps) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState<IsoDate | ''>('');
  const [endDate, setEndDate] = useState<IsoDate | ''>('');
  /** When requests close: four weeks before the start unless the manager picks another day. */
  const [closeOn, setCloseOn] = useState<IsoDate | ''>('');
  const [closeOnTouched, setCloseOnTouched] = useState(false);
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
    setCloseOn('');
    setCloseOnTouched(false);
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
      {
        name: name.trim(),
        startDate,
        endDate,
        ...(closeOn ? { requestsCloseOn: closeOn } : {}),
      },
      {
        onSuccess: (period) => {
          onCreated(period);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm" title="New period">
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
          <DateField
            id={`${formId}-start`}
            label="Start date"
            value={startDate}
            onChange={(value) => {
              setStartDate(value);
              if (!closeOnTouched && value !== '') setCloseOn(addDays(value, -28));
            }}
          />
          <DateField id={`${formId}-end`} label="End date" value={endDate} onChange={setEndDate} />
        </div>
        <div className="mt-3">
          <DateField
            id={`${formId}-close`}
            label="Time-off requests close on (optional)"
            hint="Decide the requests made by then before you generate; later ones are flagged as late."
            value={closeOn}
            onChange={(value) => {
              setCloseOn(value);
              setCloseOnTouched(true);
            }}
          />
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
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="submit"
            data-testid="new-period-save"
            disabled={createPeriod.isPending}
            className={PRIMARY}
          >
            {createPeriod.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text ' +
  'focus-visible:border-accent';
