/**
 * Roster › Accommodations: recurring windows a nurse cannot work.
 *
 * A religious, disability, pregnancy or lactation accommodation (ADA, Title VII, PWFA, the PUMP
 * Act) is a legal promise, so Generate never schedules into one and the grid flags any shift
 * that does. The reason names a faith, a condition or a pregnancy: it is shown here and nowhere
 * else, and every add, change and removal needs one, which is kept in the audit trail.
 */

import type { AvailabilityBlock, Id, IsoDate, Nurse, Weekday } from '@shiftnurse/core';
import { WEEKDAY_NAMES } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import {
  useAvailabilityBlocks,
  useCreateAvailabilityBlock,
  useRemoveAvailabilityBlock,
  useUpdateAvailabilityBlock,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { DateField } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDate } from '../../format.js';

const HELP =
  'A recurring window this nurse cannot work — a religious, disability, pregnancy or lactation accommodation. Generate never schedules into it.';
const REASON_TIP =
  'The reason is kept for HR and the audit trail; it never appears on the grid, in exports or in a nurse’s record.';

const DAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const dayLabel = (d: Weekday) => WEEKDAY_NAMES[d].slice(0, 3);

interface SectionProps {
  unitId: Id;
  nurses: readonly Nurse[];
}

function datesInForce(b: AvailabilityBlock): string {
  if (b.startsOn && b.endsOn) return `${formatDate(b.startsOn)} – ${formatDate(b.endsOn)}`;
  if (b.startsOn) return `From ${formatDate(b.startsOn)}`;
  if (b.endsOn) return `Until ${formatDate(b.endsOn)}`;
  return 'Ongoing';
}

export function AccommodationsSection({ unitId, nurses }: SectionProps) {
  const blocks = useAvailabilityBlocks(unitId);
  const [editing, setEditing] = useState<AvailabilityBlock | 'new' | undefined>(undefined);
  const [removing, setRemoving] = useState<AvailabilityBlock | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));
  const name = (id: Id) => nameOf.get(id) ?? id;

  return (
    <section className="mt-8" data-testid="accommodations-section">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Accommodations</h2>
          <p className="text-sm text-text-muted">{HELP}</p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          data-testid="accommodation-add"
          onClick={() => setEditing('new')}
        >
          Add an accommodation
        </button>
      </div>

      {blocks.isPending ? (
        <AsyncState status="loading" label="Loading accommodations" />
      ) : blocks.isError ? (
        <AsyncState status="error" label="Could not load accommodations" error={blocks.error} />
      ) : blocks.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No accommodations recorded.
        </p>
      ) : (
        <table className="w-full rounded-md border border-border bg-surface text-left text-sm">
          <thead className="text-xs text-text-muted">
            <tr>
              <th className="p-3 font-medium">Nurse</th>
              <th className="p-3 font-medium">Days</th>
              <th className="p-3 font-medium">Times</th>
              <th className="p-3 font-medium">In force</th>
              <th className="p-3 font-medium">Reason</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {blocks.data.map((b) => (
              <tr key={b.id}>
                <td className="p-3 font-medium text-text">{name(b.nurseId)}</td>
                <td className="p-3 text-text">{b.weekdays.map(dayLabel).join(', ')}</td>
                <td className="p-3 text-text">
                  {b.startTime} – {b.endTime}
                  {b.startTime === b.endTime ? ' (24 hours)' : null}
                </td>
                <td className="p-3 text-text">{datesInForce(b)}</td>
                <td className="p-3 text-text-muted">{b.reason}</td>
                <td className="p-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className={SMALL}
                      aria-label={`Edit ${name(b.nurseId)}’s accommodation`}
                      onClick={() => setEditing(b)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={SMALL}
                      aria-label={`Remove ${name(b.nurseId)}’s accommodation`}
                      onClick={() => setRemoving(b)}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing ? (
        <EditDialog
          unitId={unitId}
          nurses={nurses}
          block={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
      {removing ? (
        <RemoveDialog
          unitId={unitId}
          block={removing}
          who={name(removing.nurseId)}
          onClose={() => setRemoving(undefined)}
        />
      ) : null}
    </section>
  );
}

function EditDialog({
  unitId,
  nurses,
  block,
  onClose,
}: {
  unitId: Id;
  nurses: readonly Nurse[];
  block: AvailabilityBlock | undefined;
  onClose: () => void;
}) {
  const create = useCreateAvailabilityBlock(unitId);
  const update = useUpdateAvailabilityBlock(unitId);
  const ids = useId();
  const [nurseId, setNurseId] = useState<string>(block?.nurseId ?? '');
  const [weekdays, setWeekdays] = useState<Weekday[]>(block?.weekdays ?? []);
  const [startTime, setStartTime] = useState(block?.startTime ?? '');
  const [endTime, setEndTime] = useState(block?.endTime ?? '');
  const [startsOn, setStartsOn] = useState<IsoDate | ''>(block?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState<IsoDate | ''>(block?.endsOn ?? '');
  const [reason, setReason] = useState(block?.reason ?? '');

  const choices = nurses
    .filter((n) => n.active || n.id === block?.nurseId)
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const problem = !nurseId
    ? 'Choose the nurse.'
    : weekdays.length === 0
      ? 'Choose at least one day.'
      : !startTime || !endTime
        ? 'Enter when the window starts and ends.'
        : startsOn && endsOn && endsOn < startsOn
          ? 'The accommodation ends before it starts.'
          : !reason.trim()
            ? 'A reason is required; it is kept for HR and the audit trail.'
            : undefined;
  const pending = create.isPending || update.isPending;
  const error = errorMessage(create.error ?? update.error);

  const toggle = (day: Weekday) =>
    setWeekdays((cur) =>
      cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day].sort((a, b) => a - b),
    );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    if (block) {
      update.mutate(
        {
          id: block.id,
          patch: {
            weekdays,
            startTime,
            endTime,
            startsOn: startsOn || null,
            endsOn: endsOn || null,
          },
          reason: reason.trim(),
        },
        { onSuccess: onClose },
      );
      return;
    }
    create.mutate(
      {
        unitId,
        nurseId,
        weekdays,
        startTime,
        endTime,
        ...(startsOn ? { startsOn } : {}),
        ...(endsOn ? { endsOn } : {}),
        reason: reason.trim(),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title={block ? 'Edit accommodation' : 'Add an accommodation'}
      description="A window ending at or before its start runs past midnight; equal times cover 24 hours."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <Field id={`${ids}-nurse`} label="Nurse">
          <select
            id={`${ids}-nurse`}
            className={INPUT}
            value={nurseId}
            disabled={block !== undefined}
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

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-text">Days</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((day) => (
              <label key={day} className="flex items-center gap-1 text-sm text-text">
                <input
                  type="checkbox"
                  checked={weekdays.includes(day)}
                  onChange={() => toggle(day)}
                />
                {dayLabel(day)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-4">
          <Field id={`${ids}-start`} label="Starts at">
            <input
              id={`${ids}-start`}
              type="time"
              className={INPUT}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-end`} label="Ends at">
            <input
              id={`${ids}-end`}
              type="time"
              className={INPUT}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <DateField
            label="From (optional)"
            value={startsOn}
            onChange={setStartsOn}
            hint="Leave empty if it already applies."
          />
          <DateField
            label="Until (optional)"
            value={endsOn}
            onChange={setEndsOn}
            hint="Leave empty if it has no end."
          />
        </div>

        <Field
          id={`${ids}-reason`}
          label="Reason"
          tip={REASON_TIP}
          hint="Shown here only. Required for every change."
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

        {problem && (nurseId || weekdays.length > 0 || reason) ? (
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

function RemoveDialog({
  unitId,
  block,
  who,
  onClose,
}: {
  unitId: Id;
  block: AvailabilityBlock;
  who: string;
  onClose: () => void;
}) {
  const remove = useRemoveAvailabilityBlock(unitId);
  const ids = useId();
  const [reason, setReason] = useState('');
  const error = errorMessage(remove.error);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    remove.mutate({ id: block.id, reason: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      variant="popup"
      title={`Remove ${who}’s accommodation?`}
      description="Generate may schedule them inside this window again."
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
