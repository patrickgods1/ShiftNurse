/**
 * A nurse's scheduling preferences: shift types, days, weekend appetite and holidays they want
 * to work, each weighted. The solver prices them softly; the fairness score reports how often
 * they were honoured.
 *
 * Nothing is editable until the stored preferences have loaded: Save replaces the whole set, so
 * an editor over a failed load would erase it.
 */

import {
  compareDates,
  type Holiday,
  type Id,
  type Preference,
  today,
  WEEKDAY_NAMES,
  type Weekday,
} from '@shiftnurse/core';
import { useId, useState } from 'react';
import type { PreferenceInput } from '../../../../shared/api.js';
import { useNursePreferences, useReplacePreferences, useShiftTypes } from '../../api.js';
import { useHolidays } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { errorMessage, PRIMARY } from '../../components/ui.js';
import { useUnsavedChanges } from '../../components/unsaved-changes.js';
import { formatDate } from '../../format.js';
import { strengthLabel } from '../../preferences.js';

type PreferenceKind = Preference['kind'];

const PREFERENCE_KIND_LABELS: Record<PreferenceKind, string> = {
  prefer_shift_type: 'Prefers shift type',
  avoid_shift_type: 'Avoids shift type',
  prefer_weekday: 'Prefers weekday',
  avoid_weekday: 'Avoids weekday',
  weekend_appetite: 'Weekend appetite',
  preferred_block_length: 'Preferred block length',
  holiday_appetite: 'Wants to work holiday',
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
    case 'holiday_appetite':
      return { kind, holidayId: '', weight: 3 };
  }
}

interface RowProblem {
  text: string;
  /** Which select to mark: a repeat is the kind's fault, anything else the target's. */
  on: 'kind' | 'target';
}

function targetOf(v: PreferenceInput): string {
  switch (v.kind) {
    case 'prefer_shift_type':
    case 'avoid_shift_type':
      return v.shiftTypeId;
    case 'prefer_weekday':
    case 'avoid_weekday':
      return String(v.weekday);
    case 'holiday_appetite':
      return v.holidayId;
    default:
      return '';
  }
}

const OPPOSITE: Partial<Record<PreferenceKind, PreferenceKind>> = {
  prefer_shift_type: 'avoid_shift_type',
  avoid_shift_type: 'prefer_shift_type',
  prefer_weekday: 'avoid_weekday',
  avoid_weekday: 'prefer_weekday',
};

function problemsOf(
  rows: readonly PreferenceInput[],
  label: { shiftType(id: Id): string; weekday(day: Weekday): string },
): (RowProblem | undefined)[] {
  return rows.map((row, idx): RowProblem | undefined => {
    const n = idx + 1;
    const isShiftType = row.kind === 'prefer_shift_type' || row.kind === 'avoid_shift_type';
    if (isShiftType && row.shiftTypeId === '') {
      return { text: `Pick a shift type for row ${n}.`, on: 'target' };
    }
    if (row.kind === 'holiday_appetite' && row.holidayId === '') {
      return { text: `Pick a holiday for row ${n}.`, on: 'target' };
    }
    const target = targetOf(row);
    const opposite = OPPOSITE[row.kind];
    if (opposite !== undefined) {
      const i = rows.findIndex((r, j) => j < idx && r.kind === opposite && targetOf(r) === target);
      if (i >= 0) {
        const name =
          row.kind === 'prefer_shift_type' || row.kind === 'avoid_shift_type'
            ? label.shiftType(target as Id)
            : label.weekday(Number(target) as Weekday);
        const verb = row.kind.startsWith('avoid') ? 'avoids' : 'prefers';
        const other = row.kind.startsWith('avoid') ? 'prefers' : 'avoids';
        return { text: `Row ${n} ${verb} ${name}, which row ${i + 1} ${other}.`, on: 'target' };
      }
    }
    const i = rows.findIndex((r, j) => j < idx && r.kind === row.kind && targetOf(r) === target);
    if (i >= 0) return { text: `Row ${n} repeats row ${i + 1}.`, on: 'kind' };
    return undefined;
  });
}

/** One entry per row: what is wrong with it in words, or undefined. Row numbers are 1-based. */
export function preferenceProblems(
  rows: readonly PreferenceInput[],
  label: { shiftType(id: Id): string; weekday(day: Weekday): string },
): (string | undefined)[] {
  return problemsOf(rows, label).map((p) => p?.text);
}

function sameValues(a: readonly PreferenceInput[], b: readonly PreferenceInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function PreferencesSection({ nurseId, unitId }: { nurseId: Id; unitId: Id }) {
  const preferencesQuery = useNursePreferences(nurseId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const holidaysQuery = useHolidays(unitId);
  const replace = useReplacePreferences(nurseId);
  const problemId = useId();
  const [rows, setRows] = useState<PreferenceRow[]>([]);
  const [nextKey, setNextKey] = useState(0);
  // What the rows were last seeded from or saved as: the rows follow the server only while the
  // manager has not touched them, so a refetch never overwrites an edit in progress.
  const [baseline, setBaseline] = useState<PreferenceInput[] | undefined>(undefined);
  const [seen, setSeen] = useState<Preference[] | undefined>(undefined);

  // Adjusted during render, not in an effect: an effect would show one frame of "No preferences
  // set." and an editable empty list before the stored rows arrive.
  const data = preferencesQuery.data;
  if (data !== seen) {
    setSeen(data);
    if (
      data &&
      (baseline === undefined ||
        sameValues(
          rows.map((r) => r.value),
          baseline,
        ))
    ) {
      const seeded = toRows(data);
      setRows(seeded);
      setBaseline(seeded.map((r) => r.value));
    }
  }

  const values = rows.map((r) => r.value);
  const dirty = baseline !== undefined && !sameValues(values, baseline);
  useUnsavedChanges('Preferences', dirty);

  const shiftTypes = shiftTypesQuery.data ?? [];
  const holidays = holidaysQuery.data ?? [];
  const problems = problemsOf(values, {
    shiftType: (id) => shiftTypes.find((st) => st.id === id)?.name ?? 'that shift type',
    weekday: (day) => WEEKDAY_NAMES[day]!,
  });
  const firstProblem = problems.find((p) => p !== undefined)?.text;
  const holidaysOffered = holidayChoices(holidays, '').length > 0;

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

  const failed = [preferencesQuery, shiftTypesQuery, holidaysQuery].find((q) => q.isError);
  const loading = [preferencesQuery, shiftTypesQuery, holidaysQuery].some((q) => q.isPending);
  const saveProblemId = `${problemId}-save`;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">Preferences</h3>
        {!failed && !loading ? (
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
          >
            + Add
          </button>
        ) : null}
      </div>

      {failed ? (
        <AsyncState status="error" label="Could not load preferences" error={failed.error} />
      ) : loading ? (
        <AsyncState status="loading" label="Loading preferences" />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <PreferenceRowEditor
                key={row.key}
                row={row}
                number={i + 1}
                problem={problems[i]}
                problemId={`${problemId}-${row.key}`}
                shiftTypes={shiftTypes}
                holidays={holidays}
                holidaysOffered={holidaysOffered}
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
              onClick={() =>
                replace.mutate(values, {
                  onSuccess: () => setBaseline(values),
                })
              }
              disabled={replace.isPending || !dirty || firstProblem !== undefined}
              aria-describedby={firstProblem !== undefined ? saveProblemId : undefined}
              className={PRIMARY}
            >
              {replace.isPending ? 'Saving…' : 'Save preferences'}
            </button>
            {replace.isSuccess && !dirty ? (
              <span role="status" className="text-xs text-success">
                Saved
              </span>
            ) : null}
            {replace.isError ? (
              <span className="text-xs text-danger">
                Could not save: {errorMessage(replace.error)}
              </span>
            ) : null}
          </div>
          {firstProblem !== undefined ? (
            <p id={saveProblemId} className="mt-1 text-xs text-danger">
              {firstProblem}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function PreferenceRowEditor({
  row,
  number,
  problem,
  problemId,
  shiftTypes,
  holidays,
  holidaysOffered,
  onChange,
  onRemove,
}: {
  row: PreferenceRow;
  number: number;
  problem: RowProblem | undefined;
  problemId: string;
  shiftTypes: { id: Id; name: string }[];
  holidays: readonly Holiday[];
  holidaysOffered: boolean;
  onChange: (value: PreferenceInput) => void;
  onRemove: () => void;
}) {
  const { value } = row;
  const flag = (on: RowProblem['on']) =>
    problem?.on === on ? ({ 'aria-invalid': true, 'aria-describedby': problemId } as const) : {};

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm">
      <select
        aria-label="Preference kind"
        {...flag('kind')}
        value={value.kind}
        onChange={(e) => onChange(defaultForKind(e.target.value as PreferenceKind))}
        className="rounded-md border border-border bg-bg px-1.5 py-1"
      >
        {Object.entries(PREFERENCE_KIND_LABELS).map(([kind, label]) => {
          const noHoliday = kind === 'holiday_appetite' && !holidaysOffered && value.kind !== kind;
          return (
            <option key={kind} value={kind} disabled={noHoliday}>
              {noHoliday ? `${label} (no upcoming holidays)` : label}
            </option>
          );
        })}
      </select>

      {value.kind === 'prefer_shift_type' || value.kind === 'avoid_shift_type' ? (
        <select
          aria-label="Shift type"
          {...flag('target')}
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
          {...flag('target')}
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

      {value.kind === 'holiday_appetite' ? (
        <select
          aria-label="Holiday"
          {...flag('target')}
          value={value.holidayId}
          onChange={(e) => onChange({ ...value, holidayId: e.target.value as Id })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          <option value="">Select…</option>
          {holidayChoices(holidays, value.holidayId).map((h) => (
            <option key={h.id} value={h.id}>
              {h.name} · {formatDate(h.date)}
            </option>
          ))}
        </select>
      ) : null}

      <label
        className="ml-auto flex items-center gap-1 text-text-muted"
        title="How much this matters when Generate has to choose. Longer-serving nurses' preferences count a little more."
      >
        How much it matters
        <select
          aria-label="How much it matters"
          value={value.weight}
          onChange={(e) => onChange({ ...value, weight: Number(e.target.value) })}
          className="rounded-md border border-border bg-bg px-1.5 py-1"
        >
          {[1, 2, 3, 4, 5].map((w) => (
            <option key={w} value={w}>
              {w} — {strengthLabel(w)}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove preference ${number}`}
        className="text-xs text-danger hover:underline"
      >
        Remove
      </button>
      {problem ? (
        <p id={problemId} className="w-full text-xs text-danger">
          {problem.text}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Holidays from today on, by date. A saved wish for one already past stays listed, so the row
 * still says what it holds rather than reading as "Select…".
 */
function holidayChoices(holidays: readonly Holiday[], selected: Id): Holiday[] {
  const from = today();
  return holidays
    .filter((h) => compareDates(h.date, from) >= 0 || h.id === selected)
    .sort((a, b) => compareDates(a.date, b.date));
}
