/**
 * A nurse's leave: the balances payroll reports (PTO, annual, sick, comp time), and their FMLA
 * certifications.
 *
 * Payroll owns the figure and the manager copies it in with the date it was true on; a request is
 * checked against it carried forward by the unit's leave policy (Settings › Leave), so a stale
 * number reads as stale. Only the balances a nurse has are listed; the rest are offered.
 * Every change is audited with what it was before. A certification is the record behind an FMLA
 * request; its dates are inclusive.
 */

import type { FmlaCertificationRecord, LeaveBalanceRecord } from '@shared/api.js';
import {
  type Id,
  type IsoDate,
  LEAVE_BALANCE_TYPES,
  type LeaveBalanceType,
  TIME_OFF_TYPE_LABELS,
} from '@shiftnurse/core';
import { useId, useState } from 'react';
import {
  useAddCertification,
  useLeaveRecords,
  useRemoveCertification,
  useSetLeaveBalance,
  useUpdateCertification,
} from '../../api-leave-balances.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField } from '../../components/date-field.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

export function LeaveSection({ nurseId }: { nurseId: Id }) {
  const records = useLeaveRecords(nurseId);
  // Types the manager has opened a row for but not yet saved: a balance on file always shows.
  const [adding, setAdding] = useState<readonly LeaveBalanceType[]>([]);
  const hasBalance = (type: LeaveBalanceType) =>
    records.data?.balances.some((b) => b.type === type) ?? false;
  const shown = LEAVE_BALANCE_TYPES.filter((t) => hasBalance(t) || adding.includes(t));
  const offered = LEAVE_BALANCE_TYPES.filter((t) => !shown.includes(t));

  return (
    <section data-testid="nurse-leave" className="mt-6">
      <h3 className="mb-1 text-sm font-semibold text-text">Leave</h3>
      <p className="mb-2 text-xs text-text-muted">
        Balances come from payroll: enter the figure and the date it was true on. A request is
        checked against it and warned, never refused.
      </p>
      {records.isPending ? (
        <AsyncState status="loading" label="Loading leave" />
      ) : records.isError ? (
        <AsyncState status="error" label="Could not load leave" error={records.error} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {shown.map((type) => (
              <BalanceRow
                key={`${type}-${records.data.balances.find((b) => b.type === type)?.asOf ?? ''}`}
                nurseId={nurseId}
                type={type}
                label={TIME_OFF_TYPE_LABELS[type]}
                saved={records.data.balances.find((b) => b.type === type)}
              />
            ))}
          </div>
          {offered.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {offered.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={SMALL}
                  onClick={() => setAdding((prev) => [...prev, type])}
                >
                  {`Add ${TIME_OFF_TYPE_LABELS[type]} balance`}
                </button>
              ))}
            </div>
          ) : null}
          <Certifications nurseId={nurseId} certifications={records.data.certifications} />
        </>
      )}
    </section>
  );
}

function BalanceRow({
  nurseId,
  type,
  label,
  saved,
}: {
  nurseId: Id;
  type: LeaveBalanceType;
  label: string;
  saved: LeaveBalanceRecord | undefined;
}) {
  const set = useSetLeaveBalance(nurseId);
  const [hours, setHours] = useState(saved ? String(saved.balanceHours) : '');
  const [asOf, setAsOf] = useState<IsoDate | ''>(saved?.asOf ?? '');
  const hoursId = useId();
  const amount = Number(hours);
  const valid = hours.trim() !== '' && Number.isFinite(amount) && amount >= 0 && asOf !== '';
  const dirty = saved === undefined || amount !== saved.balanceHours || asOf !== saved.asOf;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={hoursId} className="flex flex-col gap-1 text-xs text-text-muted">
          {label} balance (hours)
          <input
            id={hoursId}
            type="number"
            min={0}
            step={0.25}
            className={INPUT}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </label>
        <DateField label={`${label} balance as of`} value={asOf} onChange={setAsOf} />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {errorMessage(set.error) !== undefined ? (
          <p role="alert" className="mr-auto text-xs text-danger">
            {errorMessage(set.error)}
          </p>
        ) : null}
        <button
          type="button"
          className={SMALL}
          disabled={!valid || !dirty || set.isPending}
          onClick={() => asOf !== '' && set.mutate({ type, balanceHours: amount, asOf })}
        >
          {`Save ${label} balance`}
        </button>
      </div>
    </div>
  );
}

function Certifications({
  nurseId,
  certifications,
}: {
  nurseId: Id;
  certifications: FmlaCertificationRecord[];
}) {
  const remove = useRemoveCertification();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<'new' | FmlaCertificationRecord | undefined>(undefined);

  const onRemove = async (c: FmlaCertificationRecord) => {
    const ok = await confirm({
      title: 'Remove this FMLA certification?',
      description: `${formatDate(c.startDate)} to ${formatDate(c.endDate)}. Requests will no longer find it on file.`,
      confirmLabel: 'Remove certification',
    });
    if (ok) remove.mutate(c.id);
  };

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-text">FMLA certifications</h4>
        <button type="button" className={SMALL} onClick={() => setEditing('new')}>
          Add certification
        </button>
      </div>
      {certifications.length === 0 && editing === undefined ? (
        <p className="text-xs text-text-muted">None on file.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {certifications.map((c) =>
            typeof editing === 'object' && editing.id === c.id ? null : (
              <li
                key={c.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-xs"
              >
                <div>
                  <div className="text-text">
                    {formatDate(c.startDate)} to {formatDate(c.endDate)}
                    {c.intermittent ? ' · intermittent' : ''}
                  </div>
                  {c.note ? <div className="text-text-muted">{c.note}</div> : null}
                </div>
                <div className="flex gap-1">
                  <button type="button" className={SMALL} onClick={() => setEditing(c)}>
                    Edit certification
                  </button>
                  <button type="button" className={SMALL} onClick={() => void onRemove(c)}>
                    Remove certification
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {errorMessage(remove.error) !== undefined ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {errorMessage(remove.error)}
        </p>
      ) : null}
      {editing !== undefined ? (
        <CertificationForm
          nurseId={nurseId}
          record={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function CertificationForm({
  nurseId,
  record,
  onDone,
}: {
  nurseId: Id;
  record: FmlaCertificationRecord | undefined;
  onDone: () => void;
}) {
  const add = useAddCertification();
  const update = useUpdateCertification();
  const [startDate, setStartDate] = useState<IsoDate | ''>(record?.startDate ?? '');
  const [endDate, setEndDate] = useState<IsoDate | ''>(record?.endDate ?? '');
  const [intermittent, setIntermittent] = useState(record?.intermittent ?? false);
  const [note, setNote] = useState(record?.note ?? '');
  const noteId = useId();

  const problem =
    !startDate || !endDate
      ? 'Enter the first and last day the certification covers.'
      : endDate < startDate
        ? 'The last day is before the first.'
        : undefined;
  const pending = add.isPending || update.isPending;
  const error = errorMessage(add.error ?? update.error);

  function submit() {
    if (problem || !startDate || !endDate) return;
    const trimmed = note.trim();
    if (record) {
      update.mutate(
        { id: record.id, patch: { startDate, endDate, intermittent, note: trimmed || null } },
        { onSuccess: onDone },
      );
    } else {
      add.mutate(
        { nurseId, startDate, endDate, intermittent, ...(trimmed ? { note: trimmed } : {}) },
        { onSuccess: onDone },
      );
    }
  }

  return (
    <form
      className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <DateField label="Certified from" value={startDate} onChange={setStartDate} />
        <DateField label="Certified through" value={endDate} onChange={setEndDate} />
      </div>
      <label className="flex items-center gap-2 text-xs text-text">
        <input
          type="checkbox"
          checked={intermittent}
          onChange={(e) => setIntermittent(e.target.checked)}
        />
        Leave may be taken intermittently
      </label>
      <label htmlFor={noteId} className="flex flex-col gap-1 text-xs text-text-muted">
        Note (optional)
        <input
          id={noteId}
          className={INPUT}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Certified by Dr. Lee, serious health condition"
        />
      </label>
      {problem && (startDate || endDate) ? (
        <p className="text-xs text-text-muted">{problem}</p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={SECONDARY} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY} disabled={pending || !!problem}>
          {pending ? 'Saving…' : 'Save certification'}
        </button>
      </div>
    </form>
  );
}
