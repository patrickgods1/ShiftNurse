/**
 * A nurse's scheduling preferences: shift types, days and weekend appetite, each weighted.
 * The solver prices them softly; the fairness score reports how often they were honoured.
 */

import type { Id, Preference } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import type { PreferenceInput } from '../../../../shared/api.js';
import { useNursePreferences, useReplacePreferences, useShiftTypes } from '../../api.js';
import { AsyncState } from '../../components/async-state.js';

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

type PreferenceKind = Preference['kind'];

const PREFERENCE_KIND_LABELS: Record<PreferenceKind, string> = {
  prefer_shift_type: 'Prefers shift type',
  avoid_shift_type: 'Avoids shift type',
  prefer_weekday: 'Prefers weekday',
  avoid_weekday: 'Avoids weekday',
  weekend_appetite: 'Weekend appetite',
  preferred_block_length: 'Preferred block length',
};

interface PreferenceRow {
  key: string;
  value: PreferenceInput;
}

function toRows(preferences: Preference[]): PreferenceRow[] {
  return preferences.map((p, i) => {
    const { id: _id, nurseId: _nurseId, ...rest } = p;
    return { key: `${p.id}-${i}`, value: rest as PreferenceInput };
  });
}

function defaultForKind(kind: PreferenceKind): PreferenceInput {
  switch (kind) {
    case 'prefer_shift_type':
    case 'avoid_shift_type':
      return { kind, shiftTypeId: '', weight: 3 };
    case 'prefer_weekday':
    case 'avoid_weekday':
      return { kind, weekday: 0, weight: 3 };
    case 'weekend_appetite':
      return { kind, level: 0, weight: 3 };
    case 'preferred_block_length':
      return { kind, shifts: 3, weight: 3 };
  }
}

export function PreferencesSection({ nurseId, unitId }: { nurseId: Id; unitId: Id }) {
  const preferencesQuery = useNursePreferences(nurseId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const replace = useReplacePreferences(nurseId);
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [nextKey, setNextKey] = useState(0);

  useEffect(() => {
    if (preferencesQuery.data) setRows(toRows(preferencesQuery.data));
  }, [preferencesQuery.data]);

  function addRow() {
    setRows((prev) => [
      ...prev,
      { key: `new-${nextKey}`, value: defaultForKind('prefer_shift_type') },
    ]);
    setNextKey((k) => k + 1);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  function updateRow(key: string, value: PreferenceInput) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, value } : r)));
  }

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Preferences</h3>
        <button
          type="button"
          onClick={addRow}
          className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
        >
          + Add
        </button>
      </div>

      {preferencesQuery.isPending || shiftTypesQuery.isPending ? (
        <AsyncState status="loading" label="Loading preferences" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <PreferenceRowEditor
                key={row.key}
                row={row}
                shiftTypes={shiftTypesQuery.data ?? []}
                onChange={(value) => updateRow(row.key, value)}
                onRemove={() => removeRow(row.key)}
              />
            ))}
          </ul>
          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">No preferences set.</p>
          ) : null}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => replace.mutate(rows.map((r) => r.value))}
              disabled={replace.isPending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                disabled:opacity-60"
            >
              {replace.isPending ? 'Saving…' : 'Save preferences'}
            </button>
            {replace.isSuccess ? <span className="text-xs text-success">Saved</span> : null}
            {replace.isError ? <span className="text-xs text-danger">Could not save</span> : null}
          </div>
        </>
      )}
    </section>
  );
}

function PreferenceRowEditor({
  row,
  shiftTypes,
  onChange,
  onRemove,
}: {
  row: PreferenceRow;
  shiftTypes: { id: Id; name: string }[];
  onChange: (value: PreferenceInput) => void;
  onRemove: () => void;
}) {
  const { value } = row;

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
      <select
        aria-label="Preference kind"
        value={value.kind}
        onChange={(e) => onChange(defaultForKind(e.target.value as PreferenceKind))}
        className="rounded-md border border-border bg-bg px-1.5 py-1"
      >
        {Object.entries(PREFERENCE_KIND_LABELS).map(([kind, label]) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>

      {value.kind === 'prefer_shift_type' || value.kind === 'avoid_shift_type' ? (
        <select
          aria-label="Shift type"
          value={value.shiftTypeId}
          onChange={(e) => onChange({ ...value, shiftTypeId: e.target.value as Id })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          <option value="">Select…</option>
          {shiftTypes.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      ) : null}

      {value.kind === 'prefer_weekday' || value.kind === 'avoid_weekday' ? (
        <select
          aria-label="Weekday"
          value={value.weekday}
          onChange={(e) =>
            onChange({
              ...value,
              weekday: Number(e.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
            })
          }
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {WEEKDAY_NAMES.map((name, i) => (
            <option key={name} value={i}>
              {name}
            </option>
          ))}
        </select>
      ) : null}

      {value.kind === 'weekend_appetite' ? (
        <select
          aria-label="Weekend appetite"
          value={value.level}
          onChange={(e) => onChange({ ...value, level: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          <option value={-1}>Wants none</option>
          <option value={0}>Neutral</option>
          <option value={1}>Wants weekends</option>
        </select>
      ) : null}

      {value.kind === 'preferred_block_length' ? (
        <select
          aria-label="Preferred block length"
          value={value.shifts}
          onChange={(e) => onChange({ ...value, shifts: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {n} shifts
            </option>
          ))}
        </select>
      ) : null}

      <label className="ml-auto flex items-center gap-1 text-text-muted">
        Weight
        <select
          aria-label="Weight"
          value={value.weight}
          onChange={(e) => onChange({ ...value, weight: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {[1, 2, 3, 4, 5].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </label>

      <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">
        Remove
      </button>
    </li>
  );
}
