/**
 * Creates a new scheduling period (name + date range). Everything else on a period —
 * assignments, the rule-set snapshot — comes from the schedule engine once shifts start landing
 * on the grid, so this form stays deliberately small. It does advise on two things main allows
 * by design — a range that cuts a pay period in two, and one that overlaps another period — since
 * both change which hours the contract rules judge; only a close date after the start is refused.
 */

import {
  addDays,
  type Id,
  type IsoDate,
  payPeriodIndex,
  payPeriodWindow,
  rangesOverlap,
  type SchedulePeriod,
  type Unit,
} from '@shiftnurse/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { usePeriods } from '../../api.js';
import { useCreatePeriod } from '../../api-schedule.js';
import { DateField } from '../../components/date-field.js';
import { Modal } from '../../components/modal.js';
import { PRIMARY, SECONDARY } from '../../components/ui.js';
import { periodRange } from '../../format.js';
import { useUnit } from '../../unit-context.js';

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
  const unit = useUnit();
  const periods = usePeriods(unitId);
  const alignment = startDate && endDate ? alignmentOf(startDate, endDate, unit) : undefined;
  const overlaps =
    startDate && endDate && startDate <= endDate
      ? (periods.data ?? []).filter((p) =>
          rangesOverlap(startDate, endDate, p.startDate, p.endDate),
        )
      : [];

  function changeStart(value: IsoDate | '') {
    setStartDate(value);
    if (!closeOnTouched && value !== '') setCloseOn(addDays(value, -28));
  }

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
    if (closeOn && closeOn > startDate) {
      setError('Requests must close on or before the day the period starts.');
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
            onChange={changeStart}
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
        {alignment !== undefined ? (
          <div
            data-testid="period-alignment"
            className="mt-3 rounded-md border border-border bg-bg p-2 text-sm text-warn"
          >
            <p>
              {alignment.messages.join(' and ')}. Hours for a pay period this schedule only partly
              covers are judged with the published schedule before it; the part after its end waits
              for the next schedule.
            </p>
            <button
              type="button"
              className={`${SECONDARY} mt-2`}
              onClick={() => {
                changeStart(alignment.start);
                setEndDate(alignment.end);
              }}
            >
              Align to pay periods
            </button>
          </div>
        ) : null}
        {overlaps.length > 0 ? (
          <div className="mt-3 rounded-md border border-border bg-bg p-2 text-sm text-text-muted">
            {overlaps.map((p) => (
              <p key={p.id} data-testid="period-overlap">
                Overlaps {p.name} ({periodRange(p)}, {p.status})
              </p>
            ))}
            <p className="mt-1">
              Overlap is allowed: a shift on both schedules is judged against each.
            </p>
          </div>
        ) : null}
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

/** Set when either end cuts a pay period in two; carries the whole-pay-period range to snap to. */
function alignmentOf(
  startDate: IsoDate,
  endDate: IsoDate,
  unit: Pick<Unit, 'payPeriodAnchor' | 'payPeriodDays'>,
) {
  if (startDate > endDate) return undefined;
  const startPP = payPeriodWindow(payPeriodIndex(startDate, unit), unit);
  const endPP = payPeriodWindow(payPeriodIndex(endDate, unit), unit);
  const messages: string[] = [];
  if (startDate !== startPP.start) {
    messages.push(
      `This period starts partway through the pay period ${periodRange({ startDate: startPP.start, endDate: startPP.end })}`,
    );
  }
  if (endDate !== endPP.end) {
    const text = `ends partway through the pay period ${periodRange({ startDate: endPP.start, endDate: endPP.end })}`;
    messages.push(messages.length === 0 ? `This period ${text}` : text);
  }
  return messages.length === 0 ? undefined : { messages, start: startPP.start, end: endPP.end };
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text ' +
  'focus-visible:border-accent';
