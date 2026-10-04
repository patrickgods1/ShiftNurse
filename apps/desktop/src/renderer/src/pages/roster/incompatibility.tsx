/**
 * Roster › Kept apart: nurses the manager does not want on the floor together. A group rather
 * than a pair, because the problem is often three or more people; its cap says how many of them
 * may overlap at once. Every schedule check reads these groups — the grid warns, Generate avoids,
 * a backfill card says so — and whenever members do overlap, the rule set's minimum of outside
 * staff must be on with them.
 *
 * Every change asks for a reason, which goes to the audit log. The reason is shown here and
 * nowhere else: violation text on the grid and in exports names the people and the hours only.
 */

import type { Id, IncompatibilityGroup, IsoDate, Nurse } from '@shiftnurse/core';
import { type FormEvent, useId, useState } from 'react';
import {
  useCreateIncompatibilityGroup,
  useIncompatibilityGroups,
  useRemoveIncompatibilityGroup,
  useUpdateIncompatibilityGroup,
} from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { DateField } from '../../components/date-field.js';
import { Modal } from '../../components/modal.js';
import {
  DANGER,
  errorMessage,
  INPUT,
  LABEL,
  PRIMARY,
  SECONDARY,
  SMALL,
} from '../../components/ui.js';
import { formatDate } from '../../format.js';

interface SectionProps {
  unitId: Id;
  nurses: readonly Nurse[];
}

export function IncompatibilitySection({ unitId, nurses }: SectionProps) {
  const groups = useIncompatibilityGroups(unitId);
  const [editing, setEditing] = useState<'new' | IncompatibilityGroup | undefined>(undefined);
  const nameOf = new Map(nurses.map((n) => [n.id, `${n.firstName} ${n.lastName}`]));

  return (
    <section className="mt-8" data-testid="incompatibility-section">
      <div className="mb-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Kept apart</h2>
          <p className="text-sm text-text-muted">
            Nurses who should not be on the floor together. Generate avoids pairing them, and
            whenever they do overlap the grid requires outside staff on with them.
          </p>
        </div>
        <button
          type="button"
          className={SECONDARY}
          data-testid="incompatibility-add"
          onClick={() => setEditing('new')}
        >
          New group
        </button>
      </div>

      {groups.isPending ? (
        <AsyncState status="loading" label="Loading groups" />
      ) : groups.isError ? (
        <AsyncState status="error" label="Could not load groups" error={groups.error} />
      ) : groups.data.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
          No groups. Add one when two or more nurses should not work the same hours.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {groups.data.map((group) => (
            <li key={group.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text">{group.name}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {group.nurseIds.map((id) => (
                    <span
                      key={id}
                      className="rounded-full border border-border px-2 py-0.5 text-xs text-text"
                    >
                      {nameOf.get(id) ?? id}
                    </span>
                  ))}
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  {capLabel(group.maxTogether)} · {rangeLabel(group)}
                </div>
                <div className="mt-1 text-xs text-text-muted">Reason: {group.reason}</div>
              </div>
              <button type="button" className={SMALL} onClick={() => setEditing(group)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined ? (
        <GroupDialog
          unitId={unitId}
          nurses={nurses}
          group={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </section>
  );
}

function capLabel(maxTogether: number): string {
  return maxTogether === 1
    ? 'No two on the floor at once'
    : `At most ${maxTogether} on the floor at once`;
}

function rangeLabel(group: IncompatibilityGroup): string {
  if (group.startsOn && group.endsOn) {
    return `${formatDate(group.startsOn)} to ${formatDate(group.endsOn)}`;
  }
  if (group.startsOn) return `From ${formatDate(group.startsOn)}`;
  if (group.endsOn) return `Until ${formatDate(group.endsOn)}`;
  return 'Until removed';
}

// ---------------------------------------------------------------------------
// Create / edit / remove
// ---------------------------------------------------------------------------

interface DialogProps {
  unitId: Id;
  nurses: readonly Nurse[];
  group: IncompatibilityGroup | undefined;
  onClose: () => void;
}

function GroupDialog({ unitId, nurses, group, onClose }: DialogProps) {
  const create = useCreateIncompatibilityGroup(unitId);
  const update = useUpdateIncompatibilityGroup(unitId);
  const remove = useRemoveIncompatibilityGroup(unitId);
  const ids = useId();

  const [name, setName] = useState(group?.name ?? '');
  const [members, setMembers] = useState<ReadonlySet<Id>>(new Set(group?.nurseIds ?? []));
  const [maxTogether, setMaxTogether] = useState(String(group?.maxTogether ?? 1));
  const [startsOn, setStartsOn] = useState<string>(group?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState<string>(group?.endsOn ?? '');
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');

  // Inactive nurses stay listed only if they are already members, so removing them is possible.
  const choices = nurses
    .filter((n) => n.active || members.has(n.id))
    .filter((n) =>
      `${n.firstName} ${n.lastName}`.toLowerCase().includes(filter.trim().toLowerCase()),
    )
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`));

  const cap = Number(maxTogether);
  const problem = !name.trim()
    ? 'Give the group a name.'
    : members.size < 2
      ? 'Choose at least two nurses.'
      : !Number.isInteger(cap) || cap < 1
        ? 'Allow at least 1 on the floor at a time.'
        : cap >= members.size
          ? `A group of ${members.size} can allow at most ${members.size - 1} at once.`
          : startsOn && endsOn && endsOn < startsOn
            ? 'The end date is before the start.'
            : !reason.trim()
              ? 'A reason is required; it goes to the audit log.'
              : undefined;
  const pending = create.isPending || update.isPending || remove.isPending;
  const error = errorMessage(create.error ?? update.error ?? remove.error);

  const toggle = (id: Id) => {
    const next = new Set(members);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMembers(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    const fields = {
      name: name.trim(),
      nurseIds: [...members],
      maxTogether: cap,
    };
    const done = { onSuccess: onClose };
    if (group) {
      update.mutate(
        {
          id: group.id,
          patch: {
            ...fields,
            startsOn: (startsOn || null) as IsoDate | null,
            endsOn: (endsOn || null) as IsoDate | null,
          },
          reason: reason.trim(),
        },
        done,
      );
    } else {
      create.mutate(
        {
          input: {
            unitId,
            ...fields,
            ...(startsOn ? { startsOn: startsOn as IsoDate } : {}),
            ...(endsOn ? { endsOn: endsOn as IsoDate } : {}),
          },
          reason: reason.trim(),
        },
        done,
      );
    }
  };

  const onRemove = () => {
    if (!group || !reason.trim()) return;
    remove.mutate({ id: group.id, reason: reason.trim() }, { onSuccess: onClose });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      variant="popup"
      title={group ? 'Edit group' : 'New group'}
      description="Judged by the hours people share: a mid shift overlapping a day shift counts."
    >
      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        <label className={LABEL}>
          Name
          <input
            className={INPUT}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nights conflict"
          />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs text-text-muted">Members ({members.size} chosen)</legend>
          <input
            type="search"
            aria-label="Filter nurses"
            className={INPUT}
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="max-h-48 overflow-y-auto rounded-md border border-border p-2">
            {choices.map((n) => (
              <label key={n.id} className="flex items-center gap-2 py-0.5 text-sm text-text">
                <input type="checkbox" checked={members.has(n.id)} onChange={() => toggle(n.id)} />
                {n.lastName}, {n.firstName}
                <span className="text-xs text-text-muted">
                  {n.role}
                  {n.active ? '' : ' · inactive'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className={LABEL}>
          How many of them may be on the floor at once
          <input
            type="number"
            min={1}
            max={Math.max(1, members.size - 1)}
            className={`${INPUT} w-24`}
            value={maxTogether}
            onChange={(e) => setMaxTogether(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <DateField
            id={`${ids}-starts`}
            label="Starts (optional)"
            value={startsOn as IsoDate | ''}
            onChange={setStartsOn}
          />
          <DateField
            id={`${ids}-ends`}
            label="Ends (optional)"
            value={endsOn as IsoDate | ''}
            onChange={setEndsOn}
          />
        </div>

        <label className={LABEL}>
          Reason for this change
          <textarea
            className={INPUT}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Recorded in the audit log. Not shown on the schedule."
          />
        </label>

        {problem && (name || members.size > 0 || reason) ? (
          <p className="text-xs text-text-muted">{problem}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          {group ? (
            <button
              type="button"
              className={DANGER}
              disabled={pending || !reason.trim()}
              onClick={onRemove}
              title={reason.trim() ? undefined : 'Enter a reason first'}
            >
              Remove group
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className={SECONDARY} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={PRIMARY} disabled={pending || !!problem}>
              {pending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
