/**
 * Coverage floors: the static minimum/target staffing per shift type, role and weekday that
 * acuity-derived demand can only push up from, never below (see the "Coverage floor" entry in
 * CLAUDE.md's domain glossary). Weekday rows are edited as a grid because that is how a
 * manager thinks about it — "nights need 3 RNs every day but 4 on weekends" — while one-off
 * date overrides (a single Christmas Eve staffing bump) are rare enough to live in a plain
 * list below instead of cluttering the grid with a mostly-empty extra dimension. A cell saves
 * when focus leaves its pair, and only if the numbers changed, so tabbing across the week
 * writes nothing.
 */

import type {
  CoverageRequirement,
  Id,
  IsoDate,
  NurseRole,
  ShiftType,
  Weekday,
} from '@shiftnurse/core';
import { WEEKDAY_NAMES } from '@shiftnurse/core';
import { useEffect, useRef, useState } from 'react';
import { useDeleteCoverage, useFillCoverageWeek, useUpsertCoverage } from '../../api-config.js';
import { useConfirm } from '../../components/confirm.js';
import { DateField } from '../../components/date-field.js';
import { errorMessage, PRIMARY } from '../../components/ui.js';
import { listLabels, useUnsavedChanges } from '../../components/unsaved-changes.js';
import { numberFieldText, parseIntegerField } from '../../field-values.js';

const ROLES: NurseRole[] = ['RN', 'LPN', 'CNA'];
const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

interface CoverageFloorsProps {
  unitId: Id;
  shiftTypes: ShiftType[];
  requirements: CoverageRequirement[];
}

interface RowKey {
  shiftTypeId: Id;
  role: NurseRole;
}

function rowKeyOf(req: { shiftTypeId: Id; role: NurseRole }): string {
  return `${req.shiftTypeId}::${req.role}`;
}

function CoverageCell({
  unitId,
  shiftTypeId,
  role,
  weekday,
  requirement,
}: {
  unitId: Id;
  shiftTypeId: Id;
  role: NurseRole;
  weekday: Weekday;
  requirement: CoverageRequirement | undefined;
}) {
  const upsert = useUpsertCoverage();
  const savedMin = numberFieldText(requirement?.minCount);
  const savedTarget = numberFieldText(requirement?.targetCount);
  const [min, setMin] = useState(savedMin);
  const [target, setTarget] = useState(savedTarget);
  const [focused, setFocused] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // After a save the draft keeps the typed numbers until the refetch brings the saved ones, so
  // the cell never flashes its old value in between.
  const settling = useRef(false);
  const seen = useRef(`${savedMin}/${savedTarget}`);

  useEffect(() => {
    const key = `${savedMin}/${savedTarget}`;
    if (seen.current !== key) {
      seen.current = key;
      settling.current = false;
    }
    if (!focused && !dirty && !settling.current) {
      setMin(savedMin);
      setTarget(savedTarget);
    }
  }, [savedMin, savedTarget, focused, dirty]);

  useUnsavedChanges('Coverage floors', dirty && error !== undefined);

  function commit() {
    const minCount = parseIntegerField(min);
    const targetCount = parseIntegerField(target);
    if (requirement === undefined && min.trim() === '' && target.trim() === '') {
      setError(undefined);
      setDirty(false);
      return;
    }
    const problem =
      minCount === undefined || targetCount === undefined
        ? 'Enter both numbers as whole numbers.'
        : minCount < 0
          ? 'Must be at least 0.'
          : targetCount < minCount
            ? 'The target cannot be below the minimum.'
            : undefined;
    if (problem !== undefined || minCount === undefined || targetCount === undefined) {
      setError(problem);
      return;
    }
    setError(undefined);
    if (requirement?.minCount === minCount && requirement.targetCount === targetCount) {
      setDirty(false);
      return;
    }
    upsert.mutate(
      {
        id: requirement?.id,
        unitId,
        shiftTypeId,
        weekday,
        date: null,
        role,
        minCount,
        targetCount,
      },
      {
        onSuccess: () => {
          settling.current = true;
          setDirty(false);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  const cellId = `${shiftTypeId}-${role}-${weekday}`;
  const label = `${role} minimum and target for ${WEEKDAY_NAMES[weekday]}`;
  const describedBy = error !== undefined ? `${cellId}-error` : undefined;
  const invalid = error !== undefined || undefined;

  return (
    <div className="flex flex-col items-center gap-0.5">
      {/* The pair saves when focus leaves both inputs: Tab from Min to Target is still editing. */}
      <fieldset
        className="flex items-center gap-0.5"
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setFocused(false);
          if (dirty) commit();
        }}
      >
        <label className="sr-only" htmlFor={`min-${cellId}`}>
          Minimum {label}
        </label>
        <input
          id={`min-${cellId}`}
          type="number"
          min={0}
          value={min}
          onChange={(event) => {
            setMin(event.target.value);
            setDirty(true);
          }}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="w-12 rounded border border-border bg-bg px-1 py-0.5 text-center text-xs text-text"
        />
        <span aria-hidden="true" className="text-text-muted">
          /
        </span>
        <label className="sr-only" htmlFor={`target-${cellId}`}>
          Target {label}
        </label>
        <input
          id={`target-${cellId}`}
          type="number"
          min={0}
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setDirty(true);
          }}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className="w-12 rounded border border-border bg-bg px-1 py-0.5 text-center text-xs text-text"
        />
      </fieldset>
      {error !== undefined ? (
        <span id={`${cellId}-error`} className="text-[10px] text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Most units staff a shift the same every day: set one day, then copy it to the other six rather
 * than typing fourteen numbers. Copies the first day that has numbers, Sunday first, in one
 * transaction, and names the days it will change before it changes them.
 */
function FillWeekButton({
  unitId,
  shiftTypeId,
  role,
  requirements,
}: {
  unitId: Id;
  shiftTypeId: Id;
  role: NurseRole;
  requirements: readonly CoverageRequirement[];
}) {
  const fill = useFillCoverageWeek();
  const confirm = useConfirm();
  const source = WEEKDAYS.map((d) => requirements.find((r) => r.weekday === d)).find(Boolean);
  const allSame =
    source !== undefined &&
    WEEKDAYS.every((d) => {
      const r = requirements.find((x) => x.weekday === d);
      return r && r.minCount === source.minCount && r.targetCount === source.targetCount;
    });
  // A day with no row is filled silently; only a day that has different numbers is overwritten.
  const differentDays =
    source === undefined
      ? []
      : WEEKDAYS.filter((d) => {
          if (d === source.weekday) return false;
          const r = requirements.find((x) => x.weekday === d);
          return (
            r !== undefined &&
            (r.minCount !== source.minCount || r.targetCount !== source.targetCount)
          );
        }).map((d) => WEEKDAY_NAMES[d] as string);

  function run() {
    if (source === undefined) return;
    fill.mutate({
      unitId,
      shiftTypeId,
      role,
      minCount: source.minCount,
      targetCount: source.targetCount,
    });
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        className="whitespace-nowrap text-xs text-accent underline underline-offset-2 disabled:text-text-muted disabled:no-underline"
        disabled={source === undefined || allSame || fill.isPending}
        title={
          source === undefined
            ? 'Fill in one day first'
            : `Copy ${source.minCount} / ${source.targetCount} to every day`
        }
        onClick={() => {
          if (source === undefined) return;
          if (differentDays.length === 0) {
            run();
            return;
          }
          void confirm({
            title: `Copy ${WEEKDAY_NAMES[source.weekday as Weekday]}'s ${source.minCount} / ${source.targetCount} to every day?`,
            description: `${listLabels(differentDays)} ${differentDays.length === 1 ? 'is' : 'are'} different now and will be changed.`,
            confirmLabel: 'Copy to every day',
            danger: false,
          }).then((ok) => {
            if (ok) run();
          });
        }}
      >
        {fill.isPending ? 'Copying…' : 'Same all week'}
      </button>
      {fill.isError ? (
        <span role="alert" className="max-w-40 text-[10px] text-danger">
          {errorMessage(fill.error)}
        </span>
      ) : null}
    </div>
  );
}

function AddRowForm({
  shiftTypes,
  existingKeys,
  onAdd,
}: {
  shiftTypes: ShiftType[];
  existingKeys: Set<string>;
  onAdd: (row: RowKey) => void;
}) {
  const firstShiftType = shiftTypes[0];
  const [shiftTypeId, setShiftTypeId] = useState<Id>(firstShiftType?.id ?? '');
  const [role, setRole] = useState<NurseRole>('RN');

  if (firstShiftType === undefined) return null;

  const alreadyExists = existingKeys.has(rowKeyOf({ shiftTypeId, role }));

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border p-3">
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Shift type
        <select
          value={shiftTypeId}
          onChange={(event) => setShiftTypeId(event.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        >
          {shiftTypes.map((shiftType) => (
            <option key={shiftType.id} value={shiftType.id}>
              {shiftType.abbreviation} — {shiftType.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Role
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as NurseRole)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={alreadyExists}
        onClick={() => onAdd({ shiftTypeId, role })}
        className={PRIMARY}
      >
        Add row
      </button>
      {alreadyExists ? (
        <span className="text-xs text-text-muted">That row already exists below.</span>
      ) : null}
    </div>
  );
}

function OverrideForm({
  unitId,
  shiftTypes,
  onAdded,
}: {
  unitId: Id;
  shiftTypes: ShiftType[];
  onAdded: () => void;
}) {
  const upsert = useUpsertCoverage();
  const firstShiftType = shiftTypes[0];
  const [date, setDate] = useState<IsoDate | ''>('');
  const [shiftTypeId, setShiftTypeId] = useState<Id>(firstShiftType?.id ?? '');
  const [role, setRole] = useState<NurseRole>('RN');
  // Blank, not 0: a zero floor is a real answer, and pressing Add on only a date saved one.
  const [min, setMin] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  useUnsavedChanges('Coverage override', date !== '' || min !== '' || target !== '');

  if (firstShiftType === undefined) return null;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const minCount = parseIntegerField(min);
        const targetCount = parseIntegerField(target);
        if (date === '') {
          setError('All fields are required');
          return;
        }
        if (minCount === undefined || targetCount === undefined) {
          setError('Enter both numbers as whole numbers.');
          return;
        }
        if (minCount < 0) {
          setError('Must be at least 0.');
          return;
        }
        if (targetCount < minCount) {
          setError('The target cannot be below the minimum.');
          return;
        }
        setError(undefined);
        upsert.mutate(
          {
            unitId,
            shiftTypeId,
            weekday: null,
            date,
            role,
            minCount,
            targetCount,
          },
          {
            // Only a saved override clears the form: a refused one keeps what was typed.
            onSuccess: () => {
              setDate('');
              setMin('');
              setTarget('');
              onAdded();
            },
          },
        );
      }}
    >
      <DateField label="Date" required value={date} onChange={setDate} />
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Shift type
        <select
          value={shiftTypeId}
          onChange={(event) => setShiftTypeId(event.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        >
          {shiftTypes.map((shiftType) => (
            <option key={shiftType.id} value={shiftType.id}>
              {shiftType.abbreviation}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Role
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as NurseRole)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Min
        <input
          type="number"
          min={0}
          value={min}
          onChange={(event) => setMin(event.target.value)}
          className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Target
        <input
          type="number"
          min={0}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        />
      </label>
      <button type="submit" className={PRIMARY}>
        Add override
      </button>
      {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
    </form>
  );
}

export default function CoverageFloors({ unitId, shiftTypes, requirements }: CoverageFloorsProps) {
  const confirm = useConfirm();
  const deleteCoverage = useDeleteCoverage();
  const [extraRows, setExtraRows] = useState<RowKey[]>([]);

  const activeShiftTypes = shiftTypes.filter((s) => s.active);
  const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));

  const weekdayRequirements = requirements.filter((r) => r.date === null);
  const dateOverrides = [...requirements.filter((r) => r.date !== null)].sort((a, b) =>
    (a.date as string).localeCompare(b.date as string),
  );

  const rowKeys = new Map<string, RowKey>();
  for (const req of weekdayRequirements) {
    rowKeys.set(rowKeyOf(req), { shiftTypeId: req.shiftTypeId, role: req.role });
  }
  for (const row of extraRows) {
    rowKeys.set(rowKeyOf(row), row);
  }

  // A row added with "Add row" is only a promise until one of its cells is saved.
  const unsavedExtraRows = extraRows.filter(
    (row) => !weekdayRequirements.some((r) => rowKeyOf(r) === rowKeyOf(row)),
  );
  useUnsavedChanges('Coverage rows', unsavedExtraRows.length > 0);

  const rows = [...rowKeys.values()].sort((a, b) => {
    const shiftA = shiftTypeById.get(a.shiftTypeId);
    const shiftB = shiftTypeById.get(b.shiftTypeId);
    const sortA = shiftA?.sortOrder ?? 0;
    const sortB = shiftB?.sortOrder ?? 0;
    if (sortA !== sortB) return sortA - sortB;
    return a.role.localeCompare(b.role);
  });

  return (
    <section>
      <h2 className="text-sm font-semibold text-text">Coverage floors</h2>
      <p className="mb-3 mt-1 max-w-prose text-sm text-text-muted">
        The fewest staff of each role every shift needs, whatever the census. When patient ratios
        call for more on a busy day, the higher number wins; the floor is never lowered. Each cell
        is <strong className="text-text">minimum / target</strong>: Generate never schedules below
        the minimum (a shift it cannot fill is reported short) and aims for the target when it has
        the staff, without going past it.
      </p>

      <div
        data-testid="coverage-grid"
        className="overflow-x-auto rounded-md border border-border bg-surface"
      >
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Shift
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Role
              </th>
              {WEEKDAYS.map((weekday) => (
                <th key={weekday} scope="col" className="px-2 py-2 text-center font-medium">
                  {WEEKDAY_NAMES[weekday]?.slice(0, 3)}
                </th>
              ))}
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">Fill the week</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  No coverage floors defined yet.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const shiftType = shiftTypeById.get(row.shiftTypeId);
                return (
                  <tr key={rowKeyOf(row)} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-text">{shiftType?.abbreviation ?? '?'}</td>
                    <td className="px-3 py-2 text-text">{row.role}</td>
                    {WEEKDAYS.map((weekday) => {
                      const requirement = weekdayRequirements.find(
                        (r) =>
                          r.shiftTypeId === row.shiftTypeId &&
                          r.role === row.role &&
                          r.weekday === weekday,
                      );
                      return (
                        <td key={weekday} className="px-1 py-1 text-center">
                          <CoverageCell
                            unitId={unitId}
                            shiftTypeId={row.shiftTypeId}
                            role={row.role}
                            weekday={weekday}
                            requirement={requirement}
                          />
                        </td>
                      );
                    })}
                    <td className="px-2 py-1">
                      <FillWeekButton
                        unitId={unitId}
                        shiftTypeId={row.shiftTypeId}
                        role={row.role}
                        requirements={weekdayRequirements.filter(
                          (r) => r.shiftTypeId === row.shiftTypeId && r.role === row.role,
                        )}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        <AddRowForm
          shiftTypes={activeShiftTypes}
          existingKeys={new Set(rows.map(rowKeyOf))}
          onAdd={(row) => setExtraRows((prev) => [...prev, row])}
        />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-text">Date-specific overrides</h3>
        <p className="mb-2 mt-1 max-w-prose text-sm text-text-muted">
          A different minimum and target for one date, replacing the weekday row above for that day
          only. Use it for a known one-off, such as extra staff on Christmas Eve or a planned surge.
        </p>
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <OverrideForm unitId={unitId} shiftTypes={activeShiftTypes} onAdded={() => undefined} />
        </div>
        {deleteCoverage.isError ? (
          <p role="alert" className="mb-2 text-xs text-danger">
            Could not delete the override: {errorMessage(deleteCoverage.error)}
          </p>
        ) : null}
        {dateOverrides.length === 0 ? (
          <p className="text-sm text-text-muted">No date overrides.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {dateOverrides.map((override) => {
              const shiftType = shiftTypeById.get(override.shiftTypeId);
              return (
                <li
                  key={override.id}
                  className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-sm"
                >
                  <span className="text-text">
                    {override.date} — {shiftType?.abbreviation ?? '?'} {override.role}:{' '}
                    {override.minCount} / {override.targetCount}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Delete this coverage override?',
                          confirmLabel: 'Delete',
                        })
                      ) {
                        deleteCoverage.mutate({ id: override.id, unitId });
                      }
                    }}
                    className="rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
