/**
 * Roster › Overtime volunteers: the offers that make an overtime shift voluntary.
 *
 * Where the law or contract bans mandatory overtime, the `no-mandatory-overtime` rule accepts an
 * overtime shift only on a date a nurse offered to work (or a stated emergency). The note records
 * how the offer was made, because that is what is quoted if the shift is disputed. Every schedule
 * check reads these, so a saved offer refreshes the grid and the day-of list.
 */

import type { Id, IsoDate, Nurse, OvertimeVolunteer } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import {
  useCreateOvertimeVolunteer,
  useOvertimeVolunteers,
  useRemoveOvertimeVolunteer,
  useUpdateOvertimeVolunteer,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

const HELP =
  'Where the law or your contract bans mandatory overtime (New York, Washington, Oregon, ' +
  'Massachusetts), an overtime shift must be one the nurse offered to work. Record the offer ' +
  'here — ‘texted Oct 3: any nights that week’. Turn the rule on under Settings › Rules.';

interface SectionProps {
  unitId: Id;
  nurses: readonly Nurse[];
}

export function OvertimeVolunteersSection({ unitId, nurses }: SectionProps) {
  const offers = useOvertimeVolunteers(unitId);
  const remove = useRemoveOvertimeVolunteer(unitId);
  const confirm = useConfirm();
  const [editing, setEditing] = useState<'new' | OvertimeVolunteer | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));

  const onRemove = async (offer: OvertimeVolunteer) => {
    const who = nameOf.get(offer.nurseId) ?? offer.nurseId;
    const ok = await confirm({
      title: `Remove ${who}’s overtime offer?`,
      description: `${rangeLabel(offer)}. Overtime shifts on those dates will no longer count as volunteered.`,
      confirmLabel: 'Remove offer',
    });
    if (ok) remove.mutate(offer.id);
  };

  return (
    <section className="mt-8" data-testid="overtime-volunteers-section">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Overtime volunteers</h2>
          <p className="text-sm text-text-muted">{HELP}</p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          data-testid="overtime-volunteer-add"
          onClick={() => setEditing('new')}
        >
          Record an offer
        </button>
      </div>

      {offers.isPending ? (
        <AsyncState status="loading" label="Loading overtime offers" />
      ) : offers.isError ? (
        <AsyncState status="error" label="Could not load overtime offers" error={offers.error} />
      ) : offers.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No offers recorded.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {offers.data.map((offer) => (
            <li key={offer.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text">
                  {nameOf.get(offer.nurseId) ?? offer.nurseId}
                </div>
                <div className="mt-1 text-xs text-text-muted">{rangeLabel(offer)}</div>
                {offer.note ? (
                  <div className="mt-1 text-xs text-text-muted">{offer.note}</div>
                ) : null}
              </div>
              <div className="flex gap-2">
                <button type="button" className={SMALL} onClick={() => setEditing(offer)}>
                  Edit
                </button>
                <button type="button" className={SMALL} onClick={() => void onRemove(offer)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {remove.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(remove.error)}
        </p>
      ) : null}

      {editing !== undefined ? (
        <OfferDialog
          unitId={unitId}
          nurses={nurses}
          offer={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

function rangeLabel(offer: Pick<OvertimeVolunteer, 'startDate' | 'endDate'>): string {
  return offer.startDate === offer.endDate
    ? formatDate(offer.startDate)
    : `${formatDate(offer.startDate)} to ${formatDate(offer.endDate)}`;
}

interface DialogProps {
  unitId: Id;
  nurses: readonly Nurse[];
  offer: OvertimeVolunteer | undefined;
  onClose: () => void;
}

function OfferDialog({ unitId, nurses, offer, onClose }: DialogProps) {
  const create = useCreateOvertimeVolunteer(unitId);
  const update = useUpdateOvertimeVolunteer(unitId);
  const ids = useId();
  const nurseFieldId = `${ids}-nurse`;
  const noteFieldId = `${ids}-note`;

  const [nurseId, setNurseId] = useState<string>(offer?.nurseId ?? '');
  const [startDate, setStartDate] = useState<IsoDate | ''>(offer?.startDate ?? '');
  const [endDate, setEndDate] = useState<IsoDate | ''>(offer?.endDate ?? '');
  const [note, setNote] = useState(offer?.note ?? '');

  // An inactive nurse stays choosable only on an offer already theirs.
  const choices = nurses
    .filter((n) => n.active || n.id === offer?.nurseId)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const problem = !nurseId
    ? 'Choose a nurse.'
    : !startDate || !endDate
      ? 'Enter the first and last day of the offer.'
      : endDate < startDate
        ? 'The last day is before the first.'
        : undefined;
  const pending = create.isPending || update.isPending;
  const error = errorMessage(create.error ?? update.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !startDate || !endDate) return;
    const trimmed = note.trim();
    if (offer) {
      update.mutate(
        { id: offer.id, patch: { startDate, endDate, note: trimmed || null } },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        { unitId, nurseId, startDate, endDate, ...(trimmed ? { note: trimmed } : {}) },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title={offer ? 'Edit overtime offer' : 'Record an overtime offer'}
      description="The dates are inclusive and compare with the shift's start date."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={nurseFieldId} label="Nurse">
          <select
            id={nurseFieldId}
            className={INPUT}
            value={nurseId}
            disabled={offer !== undefined}
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

        <div className="grid grid-cols-2 gap-4">
          <DateField
            id={`${ids}-start`}
            label="First day"
            value={startDate}
            onChange={setStartDate}
          />
          <DateField id={`${ids}-end`} label="Last day" value={endDate} onChange={setEndDate} />
        </div>

        <Field
          id={noteFieldId}
          label="How the offer was made (optional)"
          hint="Quoted if an overtime shift is disputed."
        >
          <textarea
            id={noteFieldId}
            className={INPUT}
            rows={2}
            aria-describedby={describedBy(noteFieldId, { hint: true })}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="texted Oct 3: any nights that week"
          />
        </Field>

        {problem && (nurseId || startDate || endDate) ? (
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
          <button type="submit" className={PRIMARY} disabled={pending || !!problem}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
