/**
 * Manager-entered time-off request. v1 has no nurse login, so every request arrives on paper,
 * by email or in the corridor and the manager transcribes it here; `enteredBy` is stamped
 * `'manager'` in the repository, which is the seam self-service later plugs into.
 */

import type { Id, IsoDate, Nurse, TimeOffType } from '@shiftnurse/core';
import { compareDates, daysBetween, isIsoDate, suggestedPaidLeaveHours } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useShiftTypesList } from '../../api-config.js';
import { useCreateTimeOff } from '../../api-requests.js';
import { DateField } from '../../components/date-field.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../../components/ui.js';
import { useUnit } from '../../unit-context.js';
import { LeaveStanding } from './leave-standing.js';
import { typicalShiftHours } from './paid-hours.js';

const TYPES: { value: TimeOffType; label: string }[] = [
  { value: 'pto', label: 'PTO' },
  { value: 'sick', label: 'Sick (paid)' },
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
  /** Paid hours as typed; `undefined` until the manager overrides the suggestion. */
  const [paidHours, setPaidHours] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const unit = useUnit();
  const shiftTypes = useShiftTypesList(unitId).data ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form on each open.
  useEffect(() => {
    if (!open) return;
    setNurseId('');
    setStart('');
    setEnd('');
    setType('pto');
    setReason('');
    setPaidHours(undefined);
    setProblem(undefined);
    create.reset();
  }, [open]);

  const active = nurses.filter((n) => n.active);
  const nurse = active.find((n) => n.id === nurseId);
  const days =
    isIsoDate(start) && isIsoDate(end) && compareDates(end, start) >= 0
      ? daysBetween(start, end) + 1
      : 0;
  // The shifts this nurse would have worked over those days, until the manager says otherwise.
  const suggested =
    nurse && days > 0
      ? suggestedPaidLeaveHours({
          type,
          days,
          contractedHoursPerPeriod: nurse.contractedHoursPerPeriod,
          payPeriodDays: unit.payPeriodDays,
          shiftHours: typicalShiftHours(shiftTypes),
        })
      : 0;
  const paidValue = type === 'unpaid' ? '0' : (paidHours ?? String(suggested));

  function submit() {
    if (!nurseId) return setProblem('Pick a nurse.');
    if (!isIsoDate(start) || !isIsoDate(end)) return setProblem('Enter both dates.');
    if (compareDates(end, start) < 0) return setProblem('The end date is before the start date.');
    const paid = Number(paidValue);
    if (!Number.isFinite(paid) || paid < 0) return setProblem('Paid hours must be 0 or more.');
    setProblem(undefined);
    create.mutate(
      {
        nurseId,
        startDate: start as IsoDate,
        endDate: end as IsoDate,
        type,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(paid > 0 ? { paidHours: paid } : {}),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const message = problem ?? errorMessage(create.error);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !create.isPending && onOpenChange(next)}
      data-testid="new-request-dialog"
      size="sm"
      title="New time-off request"
      description="Recorded as entered by the manager; it lands in the queue as pending."
    >
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
          <DateField
            label="First day off"
            value={isIsoDate(start) ? start : ''}
            onChange={setStart}
            required
          />
          <DateField
            label="Last day off"
            value={isIsoDate(end) ? end : ''}
            onChange={setEnd}
            min={isIsoDate(start) ? start : undefined}
            required
          />
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
          Paid hours
          <input
            type="number"
            min={0}
            step={0.25}
            className={INPUT}
            value={paidValue}
            disabled={type === 'unpaid'}
            onChange={(e) => setPaidHours(e.target.value)}
            data-testid="paid-hours"
          />
          <span>
            {type === 'unpaid'
              ? 'Unpaid leave does not count toward contracted hours.'
              : 'The shifts this nurse would have worked. Counts toward contracted hours once approved.'}
          </span>
        </label>
        <LeaveStanding
          nurseId={nurseId || undefined}
          type={type}
          start={days > 0 && isIsoDate(start) ? start : undefined}
          end={days > 0 && isIsoDate(end) ? end : undefined}
          paidHours={Number.isFinite(Number(paidValue)) ? Math.max(0, Number(paidValue)) : 0}
        />
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
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={SECONDARY}
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={create.isPending}>
            {create.isPending ? 'Saving…' : 'Add request'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
