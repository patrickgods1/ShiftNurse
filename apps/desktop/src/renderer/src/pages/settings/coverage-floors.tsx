/**
 * Coverage floors: the static minimum/target staffing per shift type, role and weekday that
 * acuity-derived demand can only push up from, never below (see the "Coverage floor" entry in
 * CLAUDE.md's domain glossary). Weekday rows are edited as a grid because that is how a
 * manager thinks about it — "nights need 3 RNs every day but 4 on weekends" — while one-off
 * date overrides (a single Christmas Eve staffing bump) are rare enough to live in a plain
 * list below instead of cluttering the grid with a mostly-empty extra dimension.
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
import { useState } from 'react';
import { useDeleteCoverage, useUpsertCoverage } from '../../api-config.js';

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
  const [min, setMin] = useState(String(requirement?.minCount ?? ''));
  const [target, setTarget] = useState(String(requirement?.targetCount ?? ''));
  const [error, setError] = useState<string | undefined>(undefined);

  function commit() {
    const minCount = Number(min);
    const targetCount = Number(target);
    if (min === '' || target === '' || Number.isNaN(minCount) || Number.isNaN(targetCount)) {
      setError('Enter both numbers');
      return;
    }
    if (minCount < 0 || targetCount < minCount) {
      setError('Target must be ≥ min ≥ 0');
      return;
    }
    setError(undefined);
    upsert.mutate({
      id: requirement?.id,
      unitId,
      shiftTypeId,
      weekday,
      date: null,
      role,
      minCount,
      targetCount,
    });
  }

  const label = `${role} minimum and target for ${WEEKDAY_NAMES[weekday]}`;

  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-0.5">
        <label className="sr-only" htmlFor={`min-${shiftTypeId}-${role}-${weekday}`}>
          Minimum {label}
        </label>
        <input
          id={`min-${shiftTypeId}-${role}-${weekday}`}
          type="number"
          min={0}
          value={min}
          onChange={(event) => setMin(event.target.value)}
          onBlur={commit}
          className="w-12 rounded border border-border bg-bg px-1 py-0.5 text-center text-xs text-text"
          aria-label={`Minimum ${label}`}
        />
        <span aria-hidden="true" className="text-text-muted">
          /
        </span>
        <label className="sr-only" htmlFor={`target-${shiftTypeId}-${role}-${weekday}`}>
          Target {label}
        </label>
        <input
          id={`target-${shiftTypeId}-${role}-${weekday}`}
          type="number"
          min={0}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onBlur={commit}
          className="w-12 rounded border border-border bg-bg px-1 py-0.5 text-center text-xs text-text"
          aria-label={`Target ${label}`}
        />
      </div>
      {error !== undefined ? <span className="text-[10px] text-danger">{error}</span> : null}
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
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90
          disabled:cursor-not-allowed disabled:opacity-50"
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
  const [date, setDate] = useState('');
  const [shiftTypeId, setShiftTypeId] = useState<Id>(firstShiftType?.id ?? '');
  const [role, setRole] = useState<NurseRole>('RN');
  const [min, setMin] = useState('0');
  const [target, setTarget] = useState('0');
  const [error, setError] = useState<string | undefined>(undefined);

  if (firstShiftType === undefined) return null;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const minCount = Number(min);
        const targetCount = Number(target);
        if (date === '' || Number.isNaN(minCount) || Number.isNaN(targetCount)) {
          setError('All fields are required');
          return;
        }
        if (minCount < 0 || targetCount < minCount) {
          setError('Target must be ≥ min ≥ 0');
          return;
        }
        setError(undefined);
        upsert.mutate(
          {
            unitId,
            shiftTypeId,
            weekday: null,
            date: date as IsoDate,
            role,
            minCount,
            targetCount,
          },
          { onSuccess: onAdded },
        );
        setDate('');
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        Date
        <input
          type="date"
          required
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
        />
      </label>
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
      <button
        type="submit"
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
      >
        Add override
      </button>
      {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
    </form>
  );
}

export default function CoverageFloors({ unitId, shiftTypes, requirements }: CoverageFloorsProps) {
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
      <h2 className="mb-3 text-sm font-semibold text-text">Coverage floors</h2>

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
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-text-muted">
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
        <h3 className="mb-2 text-sm font-semibold text-text">Date-specific overrides</h3>
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <OverrideForm unitId={unitId} shiftTypes={activeShiftTypes} onAdded={() => undefined} />
        </div>
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
                    onClick={() => {
                      if (window.confirm('Delete this coverage override?')) {
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
