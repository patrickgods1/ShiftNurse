/**
 * "Also works on": the other units a nurse may be scheduled on besides their home unit.
 *
 * A float assignment lets that unit's Generate use the nurse and puts their shifts on both units
 * in front of both grids' rest and hours checks. The competency note is the manager's own words
 * about what the nurse may be asked to do there; dates are optional and inclusive. Ending one is
 * refused while the nurse still holds shifts on that unit, so say so rather than hide it.
 */

import type { NurseUnit } from '@shared/api.js';
import type { Id, IsoDate, Nurse } from '@shiftnurse/core';
import { useState } from 'react';
import { useUnits } from '../../api.js';
import {
  useAddNurseUnit,
  useNurseUnits,
  useRemoveNurseUnit,
  useUpdateNurseUnit,
} from '../../api-nurse-units.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField } from '../../components/date-field.js';
import { Field } from '../../components/field-help.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

export function AlsoWorksOnSection({ nurse }: { nurse: Nurse }) {
  const memberships = useNurseUnits(nurse.id);
  const units = useUnits();
  const remove = useRemoveNurseUnit();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<'new' | NurseUnit | undefined>(undefined);
  const unitName = (id: Id) => units.data?.find((u) => u.id === id)?.name ?? 'Another unit';
  const others = (units.data ?? []).filter((u) => u.id !== nurse.unitId);

  const onRemove = async (m: NurseUnit) => {
    const ok = await confirm({
      title: `Stop scheduling ${nurse.firstName} on ${unitName(m.unitId)}?`,
      description:
        'That unit’s Generate will no longer use this nurse. Shifts already on its schedule must be taken off first.',
      confirmLabel: 'Remove',
    });
    if (ok) remove.mutate(m.id);
  };

  return (
    <section data-testid="nurse-also-works-on" className="mt-6">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Also works on</h3>
        <button
          type="button"
          className={SMALL}
          disabled={others.length === 0}
          onClick={() => setEditing('new')}
        >
          Add a unit
        </button>
      </div>
      <p className="mb-2 text-xs text-text-muted">
        Other units that may schedule this nurse. Their shifts there count against rest and hours
        here, and the other way round.
      </p>
      {memberships.isPending ? (
        <AsyncState status="loading" label="Loading units" />
      ) : memberships.isError ? (
        <AsyncState status="error" label="Could not load units" error={memberships.error} />
      ) : memberships.data.length === 0 && editing === undefined ? (
        <p className="text-xs text-text-muted">Works on the home unit only.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {memberships.data.map((m) =>
            typeof editing === 'object' && editing.id === m.id ? null : (
              <li
                key={m.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border p-2 text-xs"
              >
                <div>
                  <div className="text-text">{unitName(m.unitId)}</div>
                  {m.competency ? <div className="text-text-muted">{m.competency}</div> : null}
                  <div className="text-text-muted">{describeSpan(m)}</div>
                </div>
                <div className="flex gap-1">
                  <button type="button" className={SMALL} onClick={() => setEditing(m)}>
                    {`Edit ${unitName(m.unitId)}`}
                  </button>
                  <button type="button" className={SMALL} onClick={() => void onRemove(m)}>
                    {`Remove ${unitName(m.unitId)}`}
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
        <MembershipForm
          nurse={nurse}
          record={editing === 'new' ? undefined : editing}
          choices={others
            .filter((u) => editing !== 'new' || !memberships.data?.some((m) => m.unitId === u.id))
            .map((u) => ({ id: u.id, name: u.name }))}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

function describeSpan(m: NurseUnit): string {
  if (m.startDate && m.endDate) return `${formatDate(m.startDate)} to ${formatDate(m.endDate)}`;
  if (m.startDate) return `From ${formatDate(m.startDate)}`;
  if (m.endDate) return `Until ${formatDate(m.endDate)}`;
  return 'No end date';
}

function MembershipForm({
  nurse,
  record,
  choices,
  onDone,
}: {
  nurse: Nurse;
  record: NurseUnit | undefined;
  choices: { id: Id; name: string }[];
  onDone: () => void;
}) {
  const add = useAddNurseUnit();
  const update = useUpdateNurseUnit();
  const [unitId, setUnitId] = useState<Id | ''>(record?.unitId ?? choices[0]?.id ?? '');
  const [competency, setCompetency] = useState(record?.competency ?? '');
  const [startDate, setStartDate] = useState<IsoDate | ''>(record?.startDate ?? '');
  const [endDate, setEndDate] = useState<IsoDate | ''>(record?.endDate ?? '');

  const problem =
    startDate && endDate && endDate < startDate ? 'The last day is before the first.' : undefined;
  const pending = add.isPending || update.isPending;
  const error = errorMessage(add.error ?? update.error);

  function submit() {
    if (problem || unitId === '') return;
    const note = competency.trim();
    if (record) {
      update.mutate(
        {
          id: record.id,
          patch: {
            competency: note || null,
            startDate: startDate || null,
            endDate: endDate || null,
          },
        },
        { onSuccess: onDone },
      );
    } else {
      add.mutate(
        {
          nurseId: nurse.id,
          unitId,
          ...(note ? { competency: note } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
        },
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
      <Field
        id="float-unit"
        label="Unit"
        hint={
          record
            ? 'The unit cannot change; remove it and add another.'
            : 'Where the nurse may also work.'
        }
      >
        <select
          id="float-unit"
          className={INPUT}
          value={unitId}
          disabled={record !== undefined}
          onChange={(e) => setUnitId(e.target.value)}
        >
          {record && !choices.some((c) => c.id === record.unitId) ? (
            <option value={record.unitId}>{record.unitId}</option>
          ) : null}
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="float-competency"
        label="Competency note (optional)"
        hint="What this nurse may be asked to do there."
        tip="Only a note for you and the other unit’s manager: it does not change what Generate does. Write what a charge nurse would need to know, such as telemetry, central lines or no chemo."
      >
        <input
          id="float-competency"
          className={INPUT}
          value={competency}
          onChange={(e) => setCompetency(e.target.value)}
          placeholder="Telemetry, no chemo"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <DateField
          label="From (optional)"
          value={startDate}
          onChange={setStartDate}
          hint="Blank means no start date."
        />
        <DateField
          label="Through (optional)"
          value={endDate}
          onChange={setEndDate}
          hint="Blank means no end date."
        />
      </div>
      {problem ? <p className="text-xs text-text-muted">{problem}</p> : null}
      {error !== undefined ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={SECONDARY} onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY} disabled={pending || !!problem || unitId === ''}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
