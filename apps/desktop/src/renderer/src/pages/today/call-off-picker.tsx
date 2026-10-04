/**
 * "Someone called off" starts here: a name, not a hunt through shift cards. At 05:40 with the
 * phone to an ear the manager types the first letters and presses the nurse; the report dialog
 * then opens exactly as the per-row button does. Only the shifts that are running or next up are
 * offered — a call-off for anything else is rare enough to use the shift card's own row.
 */

import type { RosterEntryView, TodayShiftView } from '@shared/api.js';
import { useEffect, useState } from 'react';
import { Modal } from '../../components/modal.js';
import { INPUT } from '../../components/ui.js';

interface CallOffPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shifts: TodayShiftView[];
  onPick: (entry: RosterEntryView, shift: TodayShiftView) => void;
}

function nameOf(entry: RosterEntryView): string {
  return `${entry.nurse.lastName}, ${entry.nurse.firstName}`;
}

export function CallOffPicker({ open, onOpenChange, shifts, onPick }: CallOffPickerProps) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const live = shifts.filter((s) => s.status !== 'other');
  // With nothing running or next (a day with no schedule edge), offering nobody would be a dead end.
  const offered = live.length > 0 ? live : shifts;
  const needle = query.trim().toLowerCase();
  // Match either name order and any word's start, so "mar" finds "Martinez, Ana" and "Ana Mar".
  const matches = (entry: RosterEntryView) =>
    needle === '' ||
    [entry.nurse.firstName, entry.nurse.lastName, nameOf(entry)].some(
      (n) =>
        n
          .toLowerCase()
          .split(/[\s,]+/)
          .some((word) => word.startsWith(needle)) || n.toLowerCase().startsWith(needle),
    );
  const groups = offered
    .map((shift) => ({ shift, entries: shift.roster.filter(matches) }))
    .filter((g) => g.entries.length > 0);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Who called off?"
      description="Pick the nurse; you will confirm on the next screen."
      size="sm"
      data-testid="call-off-picker"
    >
      <input
        type="search"
        aria-label="Search by name"
        placeholder="Type a name"
        className={`${INPUT} mt-4 w-full`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: the picker exists for this one field.
        autoFocus
      />
      <div className="mt-3 flex max-h-96 flex-col gap-3 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="text-sm text-text-muted">No one on shift matches.</p>
        ) : (
          groups.map(({ shift, entries }) => (
            <section key={`${shift.date}-${shift.shiftType.id}`}>
              <h3 className="mb-1 text-xs font-semibold uppercase text-text-muted">
                {shift.shiftType.abbreviation} {shift.shiftType.name}
                {shift.status === 'current' ? ' · Now' : shift.status === 'next' ? ' · Next' : ''}
              </h3>
              <ul className="flex flex-col gap-1">
                {entries.map((entry) => {
                  const calledOff = entry.callOff !== undefined;
                  return (
                    <li key={entry.assignment.id}>
                      <button
                        type="button"
                        disabled={calledOff}
                        className="flex w-full items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm text-text hover:bg-bg disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => onPick(entry, shift)}
                      >
                        <span>
                          {nameOf(entry)}{' '}
                          <span className="text-text-muted">· {shift.shiftType.abbreviation}</span>
                        </span>
                        {calledOff ? (
                          <span className="text-xs text-text-muted">Already called off</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}
