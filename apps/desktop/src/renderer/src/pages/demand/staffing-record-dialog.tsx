/**
 * "Staffing record (Title 22)…": the unit's required and actual staffing, day by day and shift by
 * shift, for a date range, as a CSV or a PDF. 22 CCR § 70217(c) wants the actual staff and mix,
 * and the variance from what was required, documented for each shift; the app computes both for
 * Today but a figure that was never written down is gone by tomorrow. The record covers only
 * dates a published or archived schedule covers, up to today — the dialog says so before the file
 * is made, not after.
 */

import type { StaffingRecordFormat } from '@shared/api.js';
import {
  addDays,
  compareDates,
  type Id,
  type IsoDate,
  type SchedulePeriod,
  today,
} from '@shiftnurse/core';
import { useId, useState } from 'react';
import { useExportStaffingRecord } from '../../api-demand.js';
import { DateField } from '../../components/date-field.js';
import { Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY } from '../../components/ui.js';

/** The unit's latest published period; else the period holding today, else the last 14 days. */
export function defaultRecordRange(periods: readonly SchedulePeriod[]): {
  start: IsoDate;
  end: IsoDate;
} {
  const published = periods
    .filter((p) => p.status === 'published')
    .sort((a, b) => compareDates(b.startDate, a.startDate))[0];
  if (published) return { start: published.startDate, end: published.endDate };
  const now = today();
  const current = periods.find(
    (p) => compareDates(p.startDate, now) <= 0 && compareDates(now, p.endDate) <= 0,
  );
  if (current) return { start: current.startDate, end: current.endDate };
  return { start: addDays(now, -13), end: now };
}

export function StaffingRecordButton({
  unitId,
  periods,
}: {
  unitId: Id | undefined;
  periods: readonly SchedulePeriod[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={unitId === undefined}
        className={SECONDARY}
      >
        Staffing record (Title 22)…
      </button>
      {open && unitId !== undefined ? (
        <StaffingRecordDialog unitId={unitId} periods={periods} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function StaffingRecordDialog({
  unitId,
  periods,
  onClose,
}: {
  unitId: Id;
  periods: readonly SchedulePeriod[];
  onClose: () => void;
}) {
  const formatId = useId();
  const exportRecord = useExportStaffingRecord(unitId);
  const [range] = useState(() => defaultRecordRange(periods));
  const [start, setStart] = useState<IsoDate | ''>(range.start);
  const [end, setEnd] = useState<IsoDate | ''>(range.end);
  const [format, setFormat] = useState<StaffingRecordFormat>('pdf');
  const [savedTo, setSavedTo] = useState<string | undefined>(undefined);
  const problem =
    start === '' || end === ''
      ? 'Choose the first and last day.'
      : compareDates(end, start) < 0
        ? 'The last day is before the first.'
        : undefined;
  const error = errorMessage(exportRecord.error);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      variant="popup"
      size="md"
      title="Staffing record (Title 22)"
      description="For each day and shift: the staff required, the staff who worked, the variance, and the census it was judged by (22 CCR § 70217(c))."
      footer={
        <>
          <button type="button" className={SECONDARY} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className={PRIMARY}
            disabled={problem !== undefined || exportRecord.isPending}
            onClick={() => {
              if (start === '' || end === '') return;
              setSavedTo(undefined);
              exportRecord.mutate(
                { start, end, format },
                { onSuccess: (path) => setSavedTo(path) },
              );
            }}
          >
            {exportRecord.isPending ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <DateField label="From" value={start} onChange={setStart} />
          <DateField label="Through" value={end} onChange={setEnd} />
        </div>
        <Field
          id={formatId}
          label="Format"
          hint="A PDF is for reading and printing; a CSV opens in a spreadsheet."
        >
          <select
            id={formatId}
            className={INPUT}
            value={format}
            onChange={(e) => setFormat(e.target.value as StaffingRecordFormat)}
          >
            <option value="pdf">PDF</option>
            <option value="csv">CSV</option>
          </select>
        </Field>
        <p className="text-xs text-text-muted">
          Only dates a published or archived schedule covers, up to today, are included. Keep the
          exported files for at least one year.
        </p>
        {problem !== undefined && (start !== '' || end !== '') ? (
          <p className="text-xs text-text-muted">{problem}</p>
        ) : null}
        {error !== undefined ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        {savedTo !== undefined ? (
          <p role="status" className="text-xs text-text">
            Saved to {savedTo}
          </p>
        ) : exportRecord.isSuccess ? (
          <p role="status" className="text-xs text-text-muted">
            Cancelled: nothing was saved.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
