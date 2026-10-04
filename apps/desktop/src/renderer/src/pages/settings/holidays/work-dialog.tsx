/**
 * Who worked a past holiday: the list the holiday rotation reads as "last year". It comes from
 * published schedules until the manager records it by hand — for a year before the app, or when
 * the schedule does not match who came in. Recording replaces the schedules for that holiday;
 * "Use published schedules" goes back.
 */

import type { Holiday, Id, Nurse } from '@shiftnurse/core';
import { useState } from 'react';
import { useNurses } from '../../../api.js';
import { useClearHolidayWork, useHolidayWork, useRecordHolidayWork } from '../../../api-config.js';
import { AsyncState } from '../../../components/async-state.js';
import { Modal } from '../../../components/modal.js';
import { errorMessage, PRIMARY, SECONDARY } from '../../../components/ui.js';
import { formatDateWithWeekday } from '../../../format.js';

function fullName(nurse: Nurse): string {
  return `${nurse.lastName}, ${nurse.firstName}`;
}

export function HolidayWorkDialog({
  unitId,
  holiday,
  onClose,
}: {
  unitId: Id;
  holiday: Holiday | undefined;
  onClose: () => void;
}) {
  return (
    <Modal
      open={holiday !== undefined}
      onOpenChange={(open) => !open && onClose()}
      title={`Who worked ${holiday?.name ?? ''}`}
      description={
        holiday !== undefined ? (
          <>
            {formatDateWithWeekday(holiday.date)}. The holiday rotation keeps these nurses off{' '}
            {holiday.name} next year and gives it to the rest.
          </>
        ) : undefined
      }
      size="md"
    >
      {holiday !== undefined ? (
        <WorkForm key={holiday.id} unitId={unitId} holiday={holiday} onClose={onClose} />
      ) : null}
    </Modal>
  );
}

function WorkForm({
  unitId,
  holiday,
  onClose,
}: {
  unitId: Id;
  holiday: Holiday;
  onClose: () => void;
}) {
  const workQuery = useHolidayWork(holiday.id);
  const nursesQuery = useNurses(unitId);
  const record = useRecordHolidayWork();
  const clear = useClearHolidayWork();
  const [chosen, setChosen] = useState<Set<Id> | undefined>(undefined);

  const summary = workQuery.data;
  const selected = chosen ?? new Set(summary?.nurseIds ?? []);
  // Everyone on the unit now, plus anyone on the list who has since left.
  const nurses = (nursesQuery.data ?? [])
    .filter((n) => n.active || selected.has(n.id))
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const error = record.error ?? clear.error;

  return (
    <>
      {workQuery.isPending || nursesQuery.isPending ? (
        <AsyncState status="loading" label="Loading who worked" />
      ) : workQuery.isError ? (
        <AsyncState status="error" label="Could not load who worked" error={workQuery.error} />
      ) : summary === undefined ? null : (
        <>
          <p className="mt-3 text-sm text-text">
            {summary.recorded
              ? 'Recorded by hand. Published schedules are not used for this holiday.'
              : `From published schedules: ${summary.fromSchedules.length} ${
                  summary.fromSchedules.length === 1 ? 'nurse' : 'nurses'
                } worked it. Change the list to record it by hand instead.`}
          </p>
          <fieldset className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border p-2">
            <legend className="sr-only">Nurses who worked {holiday.name}</legend>
            {nurses.length === 0 ? (
              <p className="p-2 text-sm text-text-muted">No nurses on the roster.</p>
            ) : (
              nurses.map((nurse) => (
                <label
                  key={nurse.id}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm text-text hover:bg-bg"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(nurse.id)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(nurse.id);
                      else next.delete(nurse.id);
                      setChosen(next);
                    }}
                  />
                  {fullName(nurse)}
                  {nurse.active ? null : (
                    <span className="text-xs text-text-muted">(inactive)</span>
                  )}
                </label>
              ))
            )}
          </fieldset>
          {error ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {errorMessage(error)}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {summary.recorded ? (
              <button
                type="button"
                className={`${SECONDARY} mr-auto`}
                disabled={clear.isPending}
                onClick={() => clear.mutate(holiday.id, { onSuccess: () => setChosen(undefined) })}
              >
                Use published schedules
              </button>
            ) : null}
            <button type="button" className={SECONDARY} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={record.isPending || chosen === undefined}
              onClick={() =>
                record.mutate(
                  { holidayId: holiday.id, nurseIds: [...selected] },
                  { onSuccess: onClose },
                )
              }
            >
              {record.isPending ? 'Saving…' : 'Save list'}
            </button>
          </div>
        </>
      )}
    </>
  );
}
