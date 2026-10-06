/**
 * What happened on a shift that is paid outside the schedule: a missed meal or rest break, a
 * standby nurse called back in, a nurse sent home (written by the low-census cancellation itself).
 * Each is priced into the cost report's own day-of pay section, never into the schedule's cost.
 *
 * A send-home is recorded with no hours worked; the real hours go in here afterwards, because a
 * nurse who stayed an hour and a half is owed for the hours worked when they exceed the
 * reporting-time minimum.
 */

import type {
  DayOfPayEntry,
  DayOfPayRecord,
  RosterEntryView,
  TodayShiftView,
} from '@shared/api.js';
import type { Id, Nurse } from '@shiftnurse/core';
import { type ReactNode, useState } from 'react';
import {
  useDayOfPayEvents,
  useRecordDayOfPay,
  useRemoveDayOfPay,
  useUpdateDayOfPay,
} from '../../api-day-of-pay.js';
import { useGridNurses } from '../../api-nurse-units.js';
import { errorMessage, INPUT, SMALL } from '../../components/ui.js';
import { formatHours } from '../../money.js';

// The label is short now that the name is on the row; it must never wrap inside its border.
const NOWRAP = `${SMALL} whitespace-nowrap`;

function nameOf(nurse: Pick<Nurse, 'firstName' | 'lastName'> | undefined): string {
  return nurse ? `${nurse.firstName} ${nurse.lastName}` : 'A nurse';
}

function describe(e: DayOfPayRecord): string {
  if (e.kind === 'missed_break') return `Missed ${e.break} break`;
  if (e.kind === 'sent_home') {
    return `Sent home from a ${formatHours(e.scheduledHours ?? 0)} shift after ${formatHours(e.hoursWorked ?? 0)}`;
  }
  return `Called back for ${formatHours(e.hoursWorked ?? 0)}`;
}

/** The pay events recorded against this shift, and everything on the date to find them by. */
export function useShiftPayEvents(unitId: Id, shift: TodayShiftView) {
  const events = useDayOfPayEvents(unitId, shift.date, shift.date);
  return (events.data ?? []).filter((e) => e.shiftTypeId === shift.shiftType.id);
}

/** Buttons beside a nurse on the roster: a missed break, and a call-back for standby. */
export function NursePayActions({
  unitId,
  shift,
  entry,
  trailing,
}: {
  unitId: Id;
  shift: TodayShiftView;
  entry: RosterEntryView;
  /** Rendered after the idle buttons, ahead of any open form, so it stays on the name's row. */
  trailing?: ReactNode;
}) {
  const record = useRecordDayOfPay();
  const [open, setOpen] = useState<'break' | 'call-back' | undefined>(undefined);
  const [hours, setHours] = useState('');
  const who = entry.nurse.lastName;
  const where = {
    unitId,
    nurseId: entry.nurse.id,
    date: shift.date,
    shiftTypeId: shift.shiftType.id,
  };
  const error = errorMessage(record.error);
  const done = { onSuccess: () => setOpen(undefined) };

  const submit = (e: DayOfPayEntry) => record.mutate(e, done);

  return (
    // Fragment, not a wrapper: the pay buttons and `trailing` (Report call-off) must be direct
    // flex items of the nurse's row so they sit right-aligned beside the name, while an open
    // sub-form and any error take `basis-full` and wrap onto their own line beneath it.
    <>
      {open === undefined ? (
        <>
          <button
            type="button"
            className={NOWRAP}
            aria-label={`Missed break for ${who}`}
            onClick={() => setOpen('break')}
          >
            Missed break
          </button>
          {shift.shiftType.isOnCall ? (
            <button
              type="button"
              className={NOWRAP}
              aria-label={`Called back: ${who}`}
              onClick={() => setOpen('call-back')}
            >
              Called back
            </button>
          ) : null}
        </>
      ) : null}
      {trailing}
      {open === 'break' ? (
        <div className="flex basis-full flex-wrap items-center gap-1">
          <button
            type="button"
            className={NOWRAP}
            aria-label={`Missed meal break for ${who}`}
            disabled={record.isPending}
            onClick={() => submit({ kind: 'missed_break', ...where, break: 'meal' })}
          >
            Missed meal break
          </button>
          <button
            type="button"
            className={NOWRAP}
            aria-label={`Missed rest break for ${who}`}
            disabled={record.isPending}
            onClick={() => submit({ kind: 'missed_break', ...where, break: 'rest' })}
          >
            Missed rest break
          </button>
          <button type="button" className={NOWRAP} onClick={() => setOpen(undefined)}>
            Cancel
          </button>
        </div>
      ) : open === 'call-back' ? (
        <form
          className="flex basis-full items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const worked = Number(hours);
            if (worked > 0) submit({ kind: 'call_back', ...where, hoursWorked: worked });
          }}
        >
          <label className="sr-only" htmlFor={`cb-${entry.assignment.id}`}>
            {`Hours ${who} worked after the call-back`}
          </label>
          <input
            id={`cb-${entry.assignment.id}`}
            type="number"
            min={0.25}
            max={24}
            step={0.25}
            className={`${INPUT} w-20`}
            placeholder="Hours"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <button
            type="submit"
            className={NOWRAP}
            aria-label={`Record call-back for ${who}`}
            disabled={record.isPending || !(Number(hours) > 0)}
          >
            Record call-back
          </button>
          <button type="button" className={NOWRAP} onClick={() => setOpen(undefined)}>
            Cancel
          </button>
        </form>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="basis-full text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** What is recorded against the shift, with the real hours editable and each entry removable. */
export function ShiftPayEvents({ unitId, shift }: { unitId: Id; shift: TodayShiftView }) {
  const events = useShiftPayEvents(unitId, shift);
  const nurses = useGridNurses(unitId);
  if (events.length === 0) return null;
  const byId = new Map((nurses.data ?? []).map((n) => [n.id, n]));
  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="shift-pay-events">
      <h4 className="mb-1 text-xs font-semibold text-text">Pay events on this shift</h4>
      <p className="mb-1 text-xs text-text-muted">
        Priced in the cost report’s day-of pay, beside the schedule’s cost.
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {events.map((e) => (
          <PayEventRow key={e.id} event={e} name={nameOf(byId.get(e.nurseId))} />
        ))}
      </ul>
    </div>
  );
}

function PayEventRow({ event, name }: { event: DayOfPayRecord; name: string }) {
  const update = useUpdateDayOfPay();
  const remove = useRemoveDayOfPay();
  const [hours, setHours] = useState(String(event.hoursWorked ?? ''));
  const editable = event.kind !== 'missed_break';
  const worked = Number(hours);
  const error = errorMessage(update.error ?? remove.error);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-text">
        {name}: {describe(event)}
        {event.note ? <span className="ml-2 text-xs text-text-muted">{event.note}</span> : null}
      </span>
      <span className="flex items-center gap-1">
        {editable ? (
          <>
            <label className="sr-only" htmlFor={`hw-${event.id}`}>
              {`Hours ${name} worked`}
            </label>
            <input
              id={`hw-${event.id}`}
              type="number"
              min={0}
              max={24}
              step={0.25}
              className={`${INPUT} w-20`}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <button
              type="button"
              className={SMALL}
              disabled={
                update.isPending ||
                hours.trim() === '' ||
                !Number.isFinite(worked) ||
                worked === event.hoursWorked
              }
              onClick={() => update.mutate({ id: event.id, patch: { hoursWorked: worked } })}
            >
              {`Save hours for ${name}`}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={SMALL}
          disabled={remove.isPending}
          onClick={() => remove.mutate(event.id)}
        >
          {`Remove ${describe(event).toLowerCase()} for ${name}`}
        </button>
      </span>
      {error !== undefined ? (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
