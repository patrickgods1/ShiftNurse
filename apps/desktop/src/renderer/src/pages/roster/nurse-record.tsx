/**
 * "Export record…": one nurse's audit entries and published-shift changes for a date range, as a
 * CSV or a PDF, for a grievance or an HR file. The file says when, what, who and why for each
 * entry, oldest first. It leaves out kept-apart groups and their reasons, which are HR-sensitive,
 * and the dialog says so before the manager chooses, not after the file is on a shared drive.
 */

import type { NurseRecordFormat } from '@shared/api.js';
import { addDays, type IsoDate, type Nurse, today } from '@shiftnurse/core';
import { useState } from 'react';
import { useExportNurseRecord } from '../../api-nurse-record.js';
import { DateField } from '../../components/date-field.js';
import { Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY } from '../../components/ui.js';

export function ExportRecordButton({ nurse }: { nurse: Nurse }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={SECONDARY}>
        Export record…
      </button>
      {open ? <ExportRecordDialog nurse={nurse} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ExportRecordDialog({ nurse, onClose }: { nurse: Nurse; onClose: () => void }) {
  const exportRecord = useExportNurseRecord();
  const [end, setEnd] = useState<IsoDate | ''>(() => today());
  const [start, setStart] = useState<IsoDate | ''>(() => addDays(today(), -365));
  const [format, setFormat] = useState<NurseRecordFormat>('pdf');
  const [savedTo, setSavedTo] = useState<string | undefined>(undefined);
  const problem =
    start === '' || end === ''
      ? 'Choose the first and last day.'
      : end < start
        ? 'The last day is before the first.'
        : undefined;
  const error = errorMessage(exportRecord.error);

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      variant="popup"
      size="md"
      title={`Export record: ${nurse.firstName} ${nurse.lastName}`}
      description="Every entry about this nurse and every change to their published shifts in the dates chosen, oldest first, with who made it and the reason given."
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
                { nurseId: nurse.id, start, end, format },
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
          id="record-format"
          label="Format"
          hint="A PDF is for reading and printing; a CSV opens in a spreadsheet."
        >
          <select
            id="record-format"
            className={INPUT}
            value={format}
            onChange={(e) => setFormat(e.target.value as NurseRecordFormat)}
          >
            <option value="pdf">PDF</option>
            <option value="csv">CSV</option>
          </select>
        </Field>
        <p className="text-xs text-text-muted">
          Kept-apart groups and the reasons recorded for them are never included.
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
