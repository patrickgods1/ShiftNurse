/**
 * A nurse stayed past the end of the shift. The manager records how long, and whether the unit
 * required it or the nurse volunteered — the two are judged differently (mandatory-overtime laws
 * look only at required time) and a required holdover needs a reason, because that text is what
 * gets quoted if it is grieved. Clearing is the same call with 0 minutes, so a mistyped holdover
 * is one click to undo.
 *
 * The form mounts only while the dialog is open, so it starts from the saved holdover each time
 * without an effect to reset it.
 */

import type { RosterEntryView, TodayShiftView } from '@shared/api.js';
import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import { useRecordHoldover } from '../../api-dayof.js';
import { Modal } from '../../components/modal.js';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY, SMALL } from '../../components/ui.js';
import { formatDateWithWeekday, formatHoldover } from '../../format.js';

/** What the roster line says, or undefined when the shift ended on time. */
export function holdoverLine(entry: RosterEntryView): string | undefined {
  const minutes = entry.assignment.holdoverMinutes ?? 0;
  if (minutes <= 0) return undefined;
  return `Held over ${formatHoldover(minutes)} · ${entry.assignment.holdoverMandated ? 'required' : 'volunteered'}`;
}

const MAX_MINUTES = 720;

function HoldoverForm({
  unitId,
  entry,
  onClose,
}: {
  unitId: Id;
  entry: RosterEntryView;
  onClose: () => void;
}) {
  const record = useRecordHoldover(unitId);
  const saved = entry.assignment.holdoverMinutes ?? 0;
  const id = `holdover-${entry.assignment.id}`;
  const [hours, setHours] = useState(String(Math.floor(saved / 60)));
  const [minutes, setMinutes] = useState(String(saved % 60));
  const [mandated, setMandated] = useState(entry.assignment.holdoverMandated === true);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);

  const h = Number(hours || '0');
  const m = Number(minutes || '0');
  const total = h * 60 + m;
  // Each box on its own: -1h 90m sums to a legal 30 but is not a length anyone stayed.
  const lengthOk =
    Number.isInteger(h) &&
    Number.isInteger(m) &&
    h >= 0 &&
    m >= 0 &&
    total > 0 &&
    total <= MAX_MINUTES;
  const reasonMissing = mandated && reason.trim().length === 0;
  const message = errorMessage(record.error);

  const send = (mins: number, mandatedFlag: boolean, why?: string) =>
    record.mutate(
      {
        assignmentId: entry.assignment.id,
        minutes: mins,
        mandated: mandatedFlag,
        ...(why ? { reason: why } : {}),
      },
      { onSuccess: onClose },
    );

  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!lengthOk || reasonMissing) return;
        send(total, mandated, reason.trim() || undefined);
      }}
    >
      <fieldset className="flex items-end gap-2">
        <legend className="mb-1 text-xs text-text-muted">Time past the end of the shift</legend>
        <label className={LABEL}>
          Hours
          <input
            type="number"
            step={1}
            className={`${INPUT} w-20`}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to collect this length.
            autoFocus
          />
        </label>
        <label className={LABEL}>
          Minutes
          <input
            type="number"
            step={1}
            className={`${INPUT} w-20`}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
      </fieldset>
      {tried && !lengthOk ? (
        <p role="alert" className="text-xs text-danger">
          Enter a length of at least 1 minute and at most 12 hours.
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-1 text-sm text-text">
        <legend className="mb-1 text-xs text-text-muted">Why they stayed</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-kind`}
            checked={!mandated}
            onChange={() => setMandated(false)}
          />
          Volunteered to stay
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-kind`}
            checked={mandated}
            onChange={() => setMandated(true)}
          />
          Required by the unit
        </label>
      </fieldset>

      <label className={LABEL}>
        Reason{mandated ? '' : ' (optional)'}
        <textarea
          className={`${INPUT} min-h-16`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-required={mandated}
          aria-invalid={tried && reasonMissing ? true : undefined}
          aria-describedby={tried && reasonMissing ? `${id}-reason-error` : undefined}
        />
      </label>
      {tried && reasonMissing ? (
        <p id={`${id}-reason-error`} role="alert" className="text-xs text-danger">
          A required holdover needs a reason; it is what is quoted if it is grieved.
        </p>
      ) : null}

      {message !== undefined ? (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {saved > 0 ? (
          <button
            type="button"
            className={`${SECONDARY} mr-auto`}
            disabled={record.isPending}
            onClick={() => send(0, false)}
          >
            Clear
          </button>
        ) : null}
        <button type="button" className={SECONDARY} onClick={onClose} disabled={record.isPending}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY} disabled={record.isPending}>
          {record.isPending ? 'Saving…' : 'Save holdover'}
        </button>
      </div>
    </form>
  );
}

/** The "Held over…" button beside a nurse on the roster, with its dialog. */
export function HoldoverAction({
  unitId,
  shift,
  entry,
}: {
  unitId: Id;
  shift: TodayShiftView;
  entry: RosterEntryView;
}) {
  const [open, setOpen] = useState(false);
  const who = entry.nurse.lastName;
  return (
    <>
      <button
        type="button"
        className={`${SMALL} whitespace-nowrap`}
        aria-label={`Held over: ${who}`}
        onClick={() => setOpen(true)}
      >
        Held over…
      </button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        size="sm"
        data-testid="holdover-dialog"
        title={`Held over — ${entry.nurse.lastName}, ${entry.nurse.firstName}`}
        description={`${shift.shiftType.abbreviation} ${shift.shiftType.name} · ${formatDateWithWeekday(shift.date)}`}
      >
        <HoldoverForm unitId={unitId} entry={entry} onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
