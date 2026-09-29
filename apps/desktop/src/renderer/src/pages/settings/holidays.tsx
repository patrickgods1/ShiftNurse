/**
 * The unit's holiday calendar, grouped by year and within it into major and minor holidays —
 * the two groups pay and rotate differently. A holiday moves between them with one click; a
 * minor holiday can be paired with any major one the manager chooses when the rule set pairs them;
 * and each past holiday says who worked it, which is the rotation's "last year".
 *
 * A new year is added from the last (`HolidayYearDialog`), so names, the major/minor split and
 * pairings carry over instead of being re-typed; each row says which of last year's holidays
 * it continues, because the rotation matches by name and a mismatch would otherwise be silent.
 *
 * Pay and rotation are configured elsewhere (Pay › Differentials, Rules › Holiday rotation); the
 * summary at the top states what they currently do, so the manager sees the effect of "major"
 * without leaving the page.
 */

import type { Holiday, Id } from '@shiftnurse/core';
import { today } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreateHoliday,
  useDeleteHoliday,
  useHolidays,
  useRuleSet,
  useUpdateHoliday,
} from '../../api-config.js';
import { useDifferentials } from '../../api-cost.js';
import { AsyncState } from '../../components/async-state.js';
import { useConfirm } from '../../components/confirm.js';
import { CheckField, Field, InfoTip } from '../../components/field-help.js';
import { errorMessage, INPUT, PRIMARY, SMALL, SMALL_DANGER } from '../../components/ui.js';
import { formatDateWithWeekday } from '../../format.js';
import { useUnitId } from '../../unit-context.js';
import {
  describeHolidayPay,
  lastYearStatus,
  pairCandidates,
  rotationSettings,
} from './holidays/model.js';
import { HolidayWorkDialog } from './holidays/work-dialog.js';
import { HolidayYearDialog } from './holidays/year-dialog.js';

export default function HolidaysPanel() {
  const unitId = useUnitId();
  const holidaysQuery = useHolidays(unitId);
  const ruleSetQuery = useRuleSet(unitId);
  const differentialsQuery = useDifferentials(unitId);
  const [workFor, setWorkFor] = useState<Holiday | undefined>(undefined);
  const [addingYear, setAddingYear] = useState(false);

  if (holidaysQuery.isPending || ruleSetQuery.isPending || differentialsQuery.isPending) {
    return <AsyncState status="loading" label="Loading holidays" />;
  }
  const failed = [holidaysQuery, ruleSetQuery, differentialsQuery].find((q) => q.isError);
  if (failed) {
    return <AsyncState status="error" label="Could not load holidays" error={failed.error} />;
  }

  const holidays = [...(holidaysQuery.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const rotation = ruleSetQuery.data ? rotationSettings(ruleSetQuery.data) : undefined;
  const pairing = rotation?.pairMinorWithMajor ?? false;
  const pay = describeHolidayPay(differentialsQuery.data ?? []);

  const lastYear = holidays.at(-1)?.date.slice(0, 4);
  const nextYear = lastYear === undefined ? Number(today().slice(0, 4)) : Number(lastYear) + 1;

  const byYear = new Map<string, Holiday[]>();
  for (const holiday of holidays) {
    const year = holiday.date.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), holiday]);
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-text">Holidays</h2>
      <p className="mt-1 max-w-prose text-sm text-text-muted">
        A shift that starts on one of these dates is a holiday shift: it earns a holiday premium and
        counts in the fairness score, and the holiday rotation decides who works it this year. Add
        next year's dates before you build schedules that reach into it.
      </p>

      <dl className="mt-3 grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border bg-surface p-3 text-sm">
        <dt className="text-text-muted">Major holidays pay</dt>
        <dd className="text-text">{pay.major}</dd>
        <dt className="text-text-muted">Minor holidays pay</dt>
        <dd className="text-text">{pay.minor}</dd>
        <dt className="text-text-muted">Rotation</dt>
        <dd className="text-text">{describeRotation(rotation)}</dd>
        <dd className="col-span-2 text-xs text-text-muted">
          Premiums are set on the Pay tab; the rotation on Rules › Holiday rotation.
        </dd>
      </dl>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={PRIMARY} onClick={() => setAddingYear(true)}>
          Add a year of holidays
        </button>
        <span className="text-sm text-text-muted">
          {lastYear === undefined
            ? 'Starts from the US federal holidays.'
            : `Copies ${lastYear} forward to ${nextYear}: names, major or minor, and pairings.`}
        </span>
      </div>

      <AddHolidayForm unitId={unitId} holidays={holidays} pairing={pairing} />

      <div data-testid="holiday-list" className="mt-4 flex flex-col gap-6">
        {byYear.size === 0 ? (
          <p className="text-sm text-text-muted">No holidays configured yet.</p>
        ) : (
          [...byYear.entries()].map(([year, inYear]) => (
            <div key={year}>
              <h3 className="mb-2 text-sm font-semibold text-text">{year}</h3>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {([true, false] as const).map((major) => (
                  <HolidayGroup
                    key={String(major)}
                    title={major ? 'Major holidays' : 'Minor holidays'}
                    holidays={inYear.filter((h) => h.isMajor === major)}
                    all={holidays}
                    unitId={unitId}
                    pairing={pairing}
                    onWhoWorked={setWorkFor}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <HolidayWorkDialog unitId={unitId} holiday={workFor} onClose={() => setWorkFor(undefined)} />
      <HolidayYearDialog
        unitId={unitId}
        holidays={holidays}
        open={addingYear}
        defaultYear={nextYear}
        onClose={() => setAddingYear(false)}
      />
    </section>
  );
}

function describeRotation(rotation: ReturnType<typeof rotationSettings>): string {
  if (rotation === undefined) return 'off: holidays are not rotated.';
  const major = rotation.rotateMajorHolidays
    ? 'major holidays alternate year to year'
    : 'major holidays are not rotated';
  const minor = rotation.pairMinorWithMajor
    ? `minor holidays paired with a major one go to whoever is off it${
        rotation.rotateMinorHolidays ? ', the rest alternate year to year' : ''
      }`
    : rotation.rotateMinorHolidays
      ? 'minor holidays alternate year to year on their own'
      : 'minor holidays are not rotated';
  return `${major}; ${minor}.`;
}

function AddHolidayForm({
  unitId,
  holidays,
  pairing,
}: {
  unitId: Id;
  holidays: readonly Holiday[];
  pairing: boolean;
}) {
  const createHoliday = useCreateHoliday();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [isMajor, setIsMajor] = useState(false);
  const [pairedWith, setPairedWith] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const draft: Holiday | undefined =
    date === ''
      ? undefined
      : {
          id: '',
          unitId,
          date: date as Holiday['date'],
          name,
          isMajor,
          pairedHolidayId: null,
        };
  const candidates = draft && !isMajor && pairing ? pairCandidates(draft, holidays) : [];

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3 rounded-md border border-border bg-surface p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (date === '' || name.trim() === '') {
          setError('Date and name are required');
          return;
        }
        setError(undefined);
        createHoliday.mutate(
          {
            unitId,
            date: date as Holiday['date'],
            name: name.trim(),
            isMajor,
            pairedHolidayId: !isMajor && pairedWith !== '' ? (pairedWith as Id) : null,
          },
          {
            onSuccess: () => {
              setDate('');
              setName('');
              setIsMajor(false);
              setPairedWith('');
            },
          },
        );
      }}
    >
      <Field id="holiday-date" label="Date" compact>
        <input
          id="holiday-date"
          type="date"
          required
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className={INPUT}
        />
      </Field>
      <Field id="holiday-name" label="Name" compact>
        <input
          id="holiday-name"
          type="text"
          required
          value={name}
          placeholder="e.g. Christmas Day"
          list="holiday-names"
          onChange={(event) => setName(event.target.value)}
          className={INPUT}
        />
        <datalist id="holiday-names">
          {[...new Set(holidays.map((h) => h.name))].sort().map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </Field>
      <div className="pb-1.5">
        <CheckField
          id="holiday-major"
          label="Major holiday"
          tip={
            'Major holidays can pay a higher premium (Pay tab). The rotation finds last year’s ' +
            'holiday by name, so pick the name from the suggestions to keep it the same.'
          }
        >
          <input
            id="holiday-major"
            type="checkbox"
            checked={isMajor}
            onChange={(event) => setIsMajor(event.target.checked)}
          />
        </CheckField>
      </div>
      {candidates.length > 0 ? (
        <Field id="holiday-pair" label="Paired with" compact>
          <select
            id="holiday-pair"
            value={pairedWith}
            onChange={(event) => setPairedWith(event.target.value)}
            className={INPUT}
          >
            <option value="">No pair</option>
            {candidates.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.date})
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <button type="submit" className={PRIMARY} disabled={createHoliday.isPending}>
        Add holiday
      </button>
      {error !== undefined ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : createHoliday.isError ? (
        <span role="alert" className="text-xs text-danger">
          {errorMessage(createHoliday.error)}
        </span>
      ) : null}
    </form>
  );
}

function HolidayGroup({
  title,
  holidays,
  all,
  unitId,
  pairing,
  onWhoWorked,
}: {
  title: string;
  holidays: readonly Holiday[];
  all: readonly Holiday[];
  unitId: Id;
  pairing: boolean;
  onWhoWorked: (holiday: Holiday) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface">
      <h4 className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
        {title} <span className="font-normal normal-case">({holidays.length})</span>
      </h4>
      {holidays.length === 0 ? (
        <p className="px-3 py-3 text-sm text-text-muted">None.</p>
      ) : (
        <ul>
          {holidays.map((holiday) => (
            <HolidayRow
              key={holiday.id}
              holiday={holiday}
              all={all}
              unitId={unitId}
              pairing={pairing}
              onWhoWorked={onWhoWorked}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HolidayRow({
  holiday,
  all,
  unitId,
  pairing,
  onWhoWorked,
}: {
  holiday: Holiday;
  all: readonly Holiday[];
  unitId: Id;
  pairing: boolean;
  onWhoWorked: (holiday: Holiday) => void;
}) {
  const confirm = useConfirm();
  const update = useUpdateHoliday();
  const remove = useDeleteHoliday();
  const pairedMinors = all.filter((h) => h.pairedHolidayId === holiday.id);
  const partner =
    holiday.pairedHolidayId === null
      ? undefined
      : all.find((h) => h.id === holiday.pairedHolidayId);
  const candidates = !holiday.isMajor && pairing ? pairCandidates(holiday, all) : [];
  const pairId = `pair-${holiday.id}`;
  const past = holiday.date <= today();
  const status = lastYearStatus(holiday, all);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);

  const move = async () => {
    const toMajor = !holiday.isMajor;
    const unpairs = !toMajor && pairedMinors.length > 0;
    if (
      unpairs &&
      !(await confirm({
        title: `Make ${holiday.name} a minor holiday?`,
        description: `${pairedMinors.map((h) => h.name).join(', ')} ${
          pairedMinors.length === 1 ? 'is' : 'are'
        } paired with it and will be unpaired.`,
        confirmLabel: 'Make minor',
        danger: false,
      }))
    ) {
      return;
    }
    update.mutate({ id: holiday.id, unitId, patch: { isMajor: toMajor } });
  };

  return (
    <li className="flex flex-col gap-2 border-b border-border px-3 py-2 text-sm last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-text">
          {formatDateWithWeekday(holiday.date)} —{' '}
          {renaming === undefined ? (
            holiday.name
          ) : (
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (renaming.trim() === '') return;
                update.mutate(
                  { id: holiday.id, unitId, patch: { name: renaming.trim() } },
                  { onSuccess: () => setRenaming(undefined) },
                );
              }}
            >
              <input
                aria-label={`New name for ${holiday.name}`}
                value={renaming}
                list="holiday-names"
                onChange={(event) => setRenaming(event.target.value)}
                className={`${INPUT} py-0.5`}
              />
              <button type="submit" className={SMALL} disabled={update.isPending}>
                Save
              </button>
              <button type="button" className={SMALL} onClick={() => setRenaming(undefined)}>
                Cancel
              </button>
            </form>
          )}
          {holiday.isMajor && pairedMinors.length > 0 ? (
            <span className="ml-2 text-xs text-text-muted">
              paired with {pairedMinors.map((h) => h.name).join(', ')}
            </span>
          ) : null}
          {!holiday.isMajor && partner && !pairing ? (
            <span className="ml-2 text-xs text-text-muted">
              paired with {partner.name} (pairing is off)
            </span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {renaming === undefined ? (
            <button type="button" className={SMALL} onClick={() => setRenaming(holiday.name)}>
              Rename
            </button>
          ) : null}
          {past ? (
            <button type="button" className={SMALL} onClick={() => onWhoWorked(holiday)}>
              Who worked
            </button>
          ) : null}
          <button
            type="button"
            className={SMALL}
            disabled={update.isPending}
            onClick={() => void move()}
          >
            {holiday.isMajor ? 'Make minor' : 'Make major'}
          </button>
          <button
            type="button"
            className={SMALL_DANGER}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete "${holiday.name}"?`,
                  description:
                    pairedMinors.length > 0
                      ? `${pairedMinors.map((h) => h.name).join(', ')} will be unpaired.`
                      : undefined,
                  confirmLabel: 'Delete',
                })
              ) {
                remove.mutate({ id: holiday.id, unitId });
              }
            }}
          >
            Delete
          </button>
        </span>
      </div>
      {status.kind === 'continues' ? (
        <p className="text-xs text-text-muted">
          Rotates from {status.previous.name}, {formatDateWithWeekday(status.previous.date)}
        </p>
      ) : status.kind === 'no-match' ? (
        <p className="flex items-center gap-1 text-xs text-warn">
          No holiday by this name last year, so the rotation starts fresh.
          <InfoTip label={`matching ${holiday.name} to last year`}>
            The rotation finds last year’s holiday by name. If this is last year’s holiday under a
            different name (“Xmas” and “Christmas Day”), rename one of them to match.
          </InfoTip>
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <div className="flex items-center gap-2">
          <label htmlFor={pairId} className="text-xs text-text-muted">
            Paired with
          </label>
          <select
            id={pairId}
            value={holiday.pairedHolidayId ?? ''}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({
                id: holiday.id,
                unitId,
                patch: { pairedHolidayId: event.target.value === '' ? null : event.target.value },
              })
            }
            className={`${INPUT} py-0.5 text-xs`}
          >
            <option value="">No pair</option>
            {candidates.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.date})
              </option>
            ))}
          </select>
          <InfoTip label={`pairing ${holiday.name}`}>
            Whoever works the major holiday is kept off this one, and the reverse, so the two go to
            different halves of the team. Any major holiday can be chosen, however far apart.
          </InfoTip>
        </div>
      ) : null}
      {update.isError ? (
        <p role="alert" className="text-xs text-danger">
          {errorMessage(update.error)}
        </p>
      ) : null}
    </li>
  );
}
