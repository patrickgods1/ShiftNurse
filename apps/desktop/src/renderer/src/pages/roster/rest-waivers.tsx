/**
 * Roster › Rest waivers: a nurse's written waiver of minimum rest before one shift.
 *
 * VA–NNU Art. 13 §2 gives 11 hours between tours, which the nurse may waive in writing. Without
 * a record the only way to let such a turnaround stand is to relax the rule for everyone. A
 * waiver excuses the shift that STARTS on its date and no other, and both adding and removing
 * ask for a reason: it is what gets read out if the turnaround is grieved.
 */

import type { Id, IsoDate, Nurse, RestWaiver } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import { useCreateRestWaiver, useRemoveRestWaiver, useRestWaivers } from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { DateField } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

const HELP =
  'Lets a turnaround shorter than the minimum rest stand for the shift starting on this date. Needs the nurse’s written waiver.';

interface SectionProps {
  unitId: Id;
  nurses: readonly Nurse[];
}

export function RestWaiversSection({ unitId, nurses }: SectionProps) {
  const waivers = useRestWaivers(unitId);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RestWaiver | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));
  const name = (id: Id) => nameOf.get(id) ?? id;

  return (
    <section className="mt-8" data-testid="rest-waivers-section">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Rest waivers</h2>
          <p className="text-sm text-text-muted">{HELP}</p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          data-testid="rest-waiver-add"
          onClick={() => setAdding(true)}
        >
          Add a rest waiver
        </button>
      </div>

      {waivers.isPending ? (
        <AsyncState status="loading" label="Loading rest waivers" />
      ) : waivers.isError ? (
        <AsyncState status="error" label="Could not load rest waivers" error={waivers.error} />
      ) : waivers.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No rest waivers recorded.
        </p>
      ) : (
        <table className="w-full rounded-md border border-border bg-surface text-left text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="p-3 font-medium">Nurse</th>
              <th className="p-3 font-medium">Shift starting</th>
              <th className="p-3 font-medium">Reason</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {waivers.data.map((w) => (
              <tr key={w.id}>
                <td className="p-3 font-medium text-text">{name(w.nurseId)}</td>
                <td className="p-3 text-text">{formatDate(w.date)}</td>
                <td className="p-3 text-text-muted">{w.reason}</td>
                <td className="p-3 text-right">
                  <button
                    type="button"
                    className={SMALL}
                    aria-label={`Remove ${name(w.nurseId)}’s waiver for ${formatDate(w.date)}`}
                    onClick={() => setRemoving(w)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding ? (
        <AddDialog unitId={unitId} nurses={nurses} onClose={() => setAdding(false)} />
      ) : null}
      {removing ? (
        <RemoveDialog
          unitId={unitId}
          waiver={removing}
          who={name(removing.nurseId)}
          onClose={() => setRemoving(undefined)}
        />
      ) : null}
    </section>
  );
}

function AddDialog({
  unitId,
  nurses,
  onClose,
}: {
  unitId: Id;
  nurses: readonly Nurse[];
  onClose: () => void;
}) {
  const create = useCreateRestWaiver(unitId);
  const ids = useId();
  const [nurseId, setNurseId] = useState('');
  const [date, setDate] = useState<IsoDate | ''>('');
  const [reason, setReason] = useState('');

  const choices = nurses
    .filter((n) => n.active)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const problem = !nurseId
    ? 'Choose the nurse who signed the waiver.'
    : !date
      ? 'Enter the date of the shift the waiver is for.'
      : !reason.trim()
        ? 'A reason is required; it goes to the audit log.'
        : undefined;
  const error = errorMessage(create.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !date) return;
    create.mutate({ unitId, nurseId, date, reason: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title="Add a rest waiver"
      description="It excuses the shift that starts on this date, and no other."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-nurse`} label="Nurse" hint="The nurse who signed the waiver.">
          <select
            id={`${ids}-nurse`}
            className={INPUT}
            value={nurseId}
            onChange={(e) => setNurseId(e.target.value)}
          >
            <option value="">Choose a nurse…</option>
            {choices.map((n) => (
              <option key={n.id} value={n.id}>
                {n.lastName}, {n.firstName}
              </option>
            ))}
          </select>
        </Field>

        <DateField id={`${ids}-date`} label="Shift starting" value={date} onChange={setDate} />

        <Field
          id={`${ids}-reason`}
          label="Reason"
          hint="Quoted if the turnaround is grieved: who asked, and when the waiver was signed."
        >
          <textarea
            id={`${ids}-reason`}
            className={INPUT}
            rows={2}
            value={reason}
            aria-describedby={describedBy(`${ids}-reason`, { hint: true })}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>

        {problem && (nurseId || date || reason) ? (
          <p className="text-xs text-text-muted">{problem}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={create.isPending || !!problem}>
            {create.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveDialog({
  unitId,
  waiver,
  who,
  onClose,
}: {
  unitId: Id;
  waiver: RestWaiver;
  who: string;
  onClose: () => void;
}) {
  const remove = useRemoveRestWaiver(unitId);
  const ids = useId();
  const [reason, setReason] = useState('');
  const error = errorMessage(remove.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    remove.mutate({ id: waiver.id, reason: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title={`Remove ${who}’s rest waiver?`}
      description={`The shift starting ${formatDate(waiver.date)} goes back under the minimum rest rule.`}
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-reason`} label="Reason for removing it">
          <textarea
            id={`${ids}-reason`}
            className={INPUT}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={PRIMARY}
            disabled={remove.isPending || !reason.trim()}
            title={reason.trim() ? undefined : 'Enter a reason first'}
          >
            {remove.isPending ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
