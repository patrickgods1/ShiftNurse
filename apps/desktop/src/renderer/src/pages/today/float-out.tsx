/**
 * "Float out": the unit has to send a nurse to another unit for this shift. Lists who floats
 * first in the contract's order (volunteers, then the rotation, most junior among equals), each
 * place with its reason, and who is never floated and why. Only the nurse at the top can be
 * floated — main refuses anything else — so the one button is on that row, behind a confirmation
 * that repeats why. A nurse's objection is recorded with the float and never stops it.
 */

import type { TodayShiftView } from '@shared/api.js';
import { addDays, type Id, type IsoDate, type NurseRole } from '@shiftnurse/core';
import { useState } from 'react';
import { useNurses, useUnits } from '../../api.js';
import {
  useFloatHistory,
  useFloatNurse,
  useFloatOrder,
  useRecordFloatObjection,
} from '../../api-float-out.js';
import { useConfirm } from '../../components/confirm.js';
import { DANGER, errorMessage, INPUT, LABEL, SMALL } from '../../components/ui.js';
import { formatDateWithWeekday } from '../../format.js';

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];
/** How far back "Recent floats" looks. */
const RECENT_DAYS = 30;

export function FloatOut({
  unitId,
  periodId,
  shift,
}: {
  unitId: Id;
  periodId: Id;
  shift: TodayShiftView;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button type="button" className={SMALL} aria-expanded={open} onClick={() => setOpen(!open)}>
        Float out
      </button>
      {open ? <FloatPanel unitId={unitId} periodId={periodId} shift={shift} /> : null}
    </div>
  );
}

function FloatPanel({
  unitId,
  periodId,
  shift,
}: {
  unitId: Id;
  periodId: Id;
  shift: TodayShiftView;
}) {
  const confirm = useConfirm();
  const [role, setRole] = useState<NurseRole>('RN');
  // In the order they offered: the first to offer is the first volunteer floated.
  const [volunteers, setVolunteers] = useState<Id[]>([]);
  const [toUnit, setToUnit] = useState('');
  const [objection, setObjection] = useState('');
  const request = {
    periodId,
    date: shift.date,
    shiftTypeId: shift.shiftType.id,
    role,
    volunteers,
  };
  const orderQuery = useFloatOrder(request);
  const send = useFloatNurse(unitId);
  const units = useUnits();
  const view = orderQuery.data;
  const target = toUnit.trim();

  async function floatNurse(nurseId: Id, name: string, reason: string) {
    const ok = await confirm({
      title: `Float ${name} off ${shift.shiftType.abbreviation}?`,
      description: `${reason}. The shift comes off the schedule and counts as a float${
        volunteers.includes(nurseId) ? ' (volunteered)' : ' against the rotation'
      }.`,
      confirmLabel: `Float ${name}`,
    });
    if (!ok) return;
    send.mutate(
      {
        ...request,
        nurseId,
        toUnit: target,
        ...(objection.trim() ? { objection: objection.trim() } : {}),
        reason: `Floated to ${target}`,
      },
      {
        onSuccess: () => {
          setVolunteers([]);
          setObjection('');
        },
      },
    );
  }

  return (
    <div
      className="mt-2 rounded-md border border-border bg-bg p-3"
      data-testid={`float-out-${shift.shiftType.id}`}
    >
      <h3 className="text-sm font-semibold text-text">Float out</h3>
      <p className="text-xs text-text-muted">
        Volunteers first, then the rotation: fewest floats this year, then longest since the last,
        then the most junior. Whoever floats first is at the top.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Role
          <select
            className={INPUT}
            value={role}
            onChange={(e) => {
              setRole(e.target.value as NurseRole);
              setVolunteers([]);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          To unit
          <input
            className={INPUT}
            list={`float-units-${shift.shiftType.id}`}
            value={toUnit}
            onChange={(e) => setToUnit(e.target.value)}
          />
          <datalist id={`float-units-${shift.shiftType.id}`}>
            {(units.data ?? [])
              .filter((u) => u.id !== unitId)
              .map((u) => (
                <option key={u.id} value={u.name} />
              ))}
          </datalist>
        </label>
        <label className={LABEL}>
          Nurse’s objection
          <input
            className={`${INPUT} w-64`}
            value={objection}
            placeholder="Optional; recorded, never a bar to the float"
            onChange={(e) => setObjection(e.target.value)}
          />
        </label>
      </div>
      {orderQuery.isError ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(orderQuery.error)}
        </p>
      ) : null}
      {view !== undefined ? (
        <>
          <ol className="mt-2 flex flex-col gap-2 text-sm">
            {view.order.map((place) => (
              <li
                key={place.nurseId}
                className="flex items-start justify-between gap-3 rounded border border-border bg-surface px-2 py-1.5"
              >
                <div className="flex flex-col">
                  <span className="text-text">
                    {place.rank}. {place.name}
                  </span>
                  <span className="text-xs text-text-muted">{place.reason}</span>
                  <label className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                    <input
                      type="checkbox"
                      checked={volunteers.includes(place.nurseId)}
                      onChange={(e) =>
                        setVolunteers(
                          e.target.checked
                            ? [...volunteers, place.nurseId]
                            : volunteers.filter((id) => id !== place.nurseId),
                        )
                      }
                    />
                    {`${place.name} volunteered to float`}
                  </label>
                </div>
                {place.rank === 1 ? (
                  <button
                    type="button"
                    className={DANGER}
                    disabled={send.isPending || target === ''}
                    title={target === '' ? 'Name the unit first' : undefined}
                    onClick={() => void floatNurse(place.nurseId, place.name, place.reason)}
                  >
                    {`Float ${place.name}`}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {view.excluded.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-text-muted">
              {view.excluded.map((e) => (
                <li key={e.nurseId}>
                  <span className="font-medium">Not floated:</span> {e.name}: {e.reason}
                </li>
              ))}
            </ul>
          ) : null}
          {view.order.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">
              Nobody on this shift can be floated for this role.
            </p>
          ) : null}
        </>
      ) : null}
      {errorMessage(send.error) !== undefined ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {errorMessage(send.error)}
        </p>
      ) : null}
      <RecentFloats unitId={unitId} since={addDays(shift.date, -RECENT_DAYS)} />
    </div>
  );
}

function RecentFloats({ unitId, since }: { unitId: Id; since: IsoDate }) {
  const history = useFloatHistory(unitId, since);
  const nurses = useNurses(unitId);
  const record = useRecordFloatObjection();
  const [editing, setEditing] = useState<Id>();
  const [text, setText] = useState('');
  const nameOf = (id: Id) => {
    const n = nurses.data?.find((x) => x.id === id);
    return n ? `${n.firstName} ${n.lastName}` : id;
  };
  const floats = [...(history.data ?? [])].reverse();
  if (floats.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border pt-2">
      <h4 className="text-xs font-semibold text-text">Recent floats</h4>
      <ul className="mt-1 flex flex-col gap-1 text-xs text-text-muted">
        {floats.map((f) => (
          <li key={f.id} className="flex flex-col gap-1">
            <span>
              {nameOf(f.nurseId)} to {f.toUnit}, {formatDateWithWeekday(f.date)}
              {f.volunteered ? ' (volunteered)' : ''}
              {f.objection ? ` — Objection: ${f.objection}` : ''}
            </span>
            {editing === f.id ? (
              <span className="flex gap-2">
                <input
                  aria-label={`Objection from ${nameOf(f.nurseId)}`}
                  className={`${INPUT} w-64`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <button
                  type="button"
                  className={SMALL}
                  disabled={text.trim() === '' || record.isPending}
                  onClick={() =>
                    record.mutate(
                      { id: f.id, objection: text },
                      { onSuccess: () => setEditing(undefined) },
                    )
                  }
                >
                  Save objection
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={`${SMALL} self-start`}
                aria-label={`Record objection for ${nameOf(f.nurseId)}`}
                onClick={() => {
                  setEditing(f.id);
                  setText(f.objection ?? '');
                }}
              >
                Record objection
              </button>
            )}
          </li>
        ))}
      </ul>
      {errorMessage(record.error) !== undefined ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {errorMessage(record.error)}
        </p>
      ) : null}
    </div>
  );
}
