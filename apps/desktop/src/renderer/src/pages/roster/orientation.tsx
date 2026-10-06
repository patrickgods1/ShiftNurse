/**
 * Roster › Orientation: which nurse is oriented by which.
 *
 * `orientee-with-preceptor` keeps an orientee only on shifts one of their preceptors is on, and
 * Generate plans them together. An orientee may have several preceptors (the same weeks, covered
 * by whoever is on), so the dialog takes several and stores one record each. The dates are
 * inclusive and compare with the shift's start date.
 */

import type { Id, IsoDate, Nurse, Preceptorship } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import {
  useCreatePreceptorship,
  usePreceptorships,
  useRemovePreceptorship,
  useUpdatePreceptorship,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField } from '../../components/date-field.js';
import { Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

const HELP =
  'An orientee works only on shifts one of their preceptors is on; Generate keeps them together.';

interface SectionProps {
  unitId: Id;
  nurses: readonly Nurse[];
}

function rangeLabel(p: Pick<Preceptorship, 'startDate' | 'endDate'>): string {
  return `${formatDate(p.startDate)} to ${formatDate(p.endDate)}`;
}

export function OrientationSection({ unitId, nurses }: SectionProps) {
  const records = usePreceptorships(unitId);
  const remove = useRemovePreceptorship(unitId);
  const confirm = useConfirm();
  const [editing, setEditing] = useState<'new' | Preceptorship | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));
  const name = (id: Id) => nameOf.get(id) ?? id;

  const onRemove = async (p: Preceptorship) => {
    const ok = await confirm({
      title: `End ${name(p.orienteeId)}’s orientation with ${name(p.preceptorId)}?`,
      description: `${rangeLabel(p)}. ${name(p.orienteeId)} will no longer be kept to ${name(p.preceptorId)}’s shifts.`,
      confirmLabel: 'Remove',
    });
    if (ok) remove.mutate(p.id);
  };

  return (
    <section className="mt-8" data-testid="orientation-section">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Orientation</h2>
          <p className="text-sm text-text-muted">{HELP}</p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          data-testid="orientation-add"
          onClick={() => setEditing('new')}
        >
          Add an orientation
        </button>
      </div>

      {records.isPending ? (
        <AsyncState status="loading" label="Loading orientations" />
      ) : records.isError ? (
        <AsyncState status="error" label="Could not load orientations" error={records.error} />
      ) : records.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No orientations recorded.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {records.data.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text">
                  {name(p.orienteeId)} with {name(p.preceptorId)}
                </div>
                <div className="mt-1 text-xs text-text-muted">{rangeLabel(p)}</div>
              </div>
              <div className="flex gap-2">
                <button type="button" className={SMALL} onClick={() => setEditing(p)}>
                  Edit
                </button>
                <button type="button" className={SMALL} onClick={() => void onRemove(p)}>
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
        <OrientationDialog
          unitId={unitId}
          nurses={nurses}
          record={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

interface DialogProps {
  unitId: Id;
  nurses: readonly Nurse[];
  record: Preceptorship | undefined;
  onClose: () => void;
}

function OrientationDialog({ unitId, nurses, record, onClose }: DialogProps) {
  const create = useCreatePreceptorship(unitId);
  const update = useUpdatePreceptorship(unitId);
  const ids = useId();
  const [orienteeId, setOrienteeId] = useState<string>(record?.orienteeId ?? '');
  const [preceptorIds, setPreceptorIds] = useState<Id[]>(record ? [record.preceptorId] : []);
  const [startDate, setStartDate] = useState<IsoDate | ''>(record?.startDate ?? '');
  const [endDate, setEndDate] = useState<IsoDate | ''>(record?.endDate ?? '');

  const choices = nurses
    .filter((n) => n.active)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const problem = !orienteeId
    ? 'Choose the nurse in orientation.'
    : preceptorIds.length === 0
      ? 'Choose at least one preceptor.'
      : !startDate || !endDate
        ? 'Enter the first and last day of the orientation.'
        : endDate < startDate
          ? 'The last day is before the first.'
          : undefined;
  const pending = create.isPending || update.isPending;
  const error = errorMessage(create.error ?? update.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || !startDate || !endDate) return;
    if (record) {
      update.mutate({ id: record.id, patch: { startDate, endDate } }, { onSuccess: onClose });
    } else {
      create.mutate(
        { unitId, orienteeId, preceptorIds, startDate, endDate },
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
      title={record ? 'Edit orientation' : 'Add an orientation'}
      description="The dates are inclusive and compare with the shift's start date."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-orientee`} label="Orientee" hint="The nurse who is learning the unit.">
          <select
            id={`${ids}-orientee`}
            className={INPUT}
            value={orienteeId}
            disabled={record !== undefined}
            onChange={(e) => setOrienteeId(e.target.value)}
          >
            <option value="">Choose a nurse…</option>
            {choices.map((n) => (
              <option key={n.id} value={n.id}>
                {n.lastName}, {n.firstName}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="flex flex-col gap-1" disabled={record !== undefined}>
          <legend className="text-xs text-text-muted">Preceptors</legend>
          <p className="text-xs text-text-muted">
            The orientee may work any shift one of these nurses is on.
          </p>
          <div className="mt-1 grid max-h-40 grid-cols-2 gap-1 overflow-y-auto">
            {choices
              .filter((n) => n.id !== orienteeId)
              .map((n) => (
                <label key={n.id} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={preceptorIds.includes(n.id)}
                    onChange={(e) =>
                      setPreceptorIds(
                        e.target.checked
                          ? [...preceptorIds, n.id]
                          : preceptorIds.filter((id) => id !== n.id),
                      )
                    }
                  />
                  {n.firstName} {n.lastName}
                </label>
              ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <DateField
            id={`${ids}-start`}
            label="First day"
            value={startDate}
            onChange={setStartDate}
          />
          <DateField id={`${ids}-end`} label="Last day" value={endDate} onChange={setEndDate} />
        </div>

        {problem && (orienteeId || startDate || endDate) ? (
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
