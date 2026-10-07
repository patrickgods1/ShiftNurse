/** Shift differentials: nights, weekends, holidays, charge — flat or percentage, switchable. */

import type { Differential, DifferentialKind, Id } from '@shiftnurse/core';
import { COST_LINE_LABELS, DIFFERENTIAL_ORDER } from '@shiftnurse/core';
import { useState } from 'react';
import {
  useCreateDifferential,
  useDeleteDifferential,
  useDifferentials,
  useUpdateDifferential,
} from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { useConfirm } from '../../../components/confirm.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT, LABEL, PRIMARY, SMALL, SMALL_DANGER, TD, TH } from '../../../components/ui.js';
import { formatDollars } from '../../../money.js';

const DIFFERENTIAL_HELP: Record<DifferentialKind, string> = {
  night:
    'Shifts whose type is marked as night, or by clock time: the hours that fall in a daily window',
  evening: 'Paid for the hours in an evening window, e.g. 15:00–23:00, as many contracts do',
  weekend: 'Shifts inside the weekend window defined on the Rules tab',
  holiday:
    'Shifts starting on a holiday from the Holidays tab. With a major-holiday premium set, minor holidays only',
  major_holiday:
    'Shifts starting on a major holiday, in place of the holiday premium. Without it, majors earn the holiday premium',
  charge: 'Shifts where the nurse is the charge nurse',
  on_call: 'Standby hours — paid instead of base pay, not on top of it',
  call_back: 'Being called in while on standby (priced by the day-of console)',
  agency: 'Every worked shift of an agency nurse',
};

const NIGHT_WHY =
  'Under the VA rule (38 U.S.C. §7453(b)) the night differential is 10% on the whole tour when at least 4 hours fall between 6 pm and 6 am, and otherwise only on the hours inside that window. Set the window to 18:00–06:00 and the whole-shift hours to 4. Leave the whole-shift hours empty to pay only the hours inside the window.';
const EVENING_WHY =
  'Many contracts pay an evening differential for the hours inside a clock window such as 15:00–23:00. Leave the whole-shift hours empty to pay only those hours, or enter a number to pay the whole shift once that many hours fall in the window.';

interface WindowForm {
  start: string;
  end: string;
  whole: string;
}
const EMPTY_WINDOW: WindowForm = { start: '', end: '', whole: '' };

const takesWindow = (kind: DifferentialKind) => kind === 'night' || kind === 'evening';

function windowFormOf(window: Differential['window']): WindowForm {
  return window === undefined
    ? EMPTY_WINDOW
    : {
        start: window.startTime,
        end: window.endTime,
        whole: window.wholeShiftAtHours === null ? '' : String(window.wholeShiftAtHours),
      };
}

/** The window the form describes, or the reason it cannot be saved. */
function windowOf(form: WindowForm): Differential['window'] | string {
  if (form.start === '' || form.end === '') return 'Enter a start and an end time for the window';
  const whole = form.whole.trim() === '' ? null : Number(form.whole);
  if (whole !== null && !(whole > 0)) return 'Whole-shift hours must be more than 0';
  return { startTime: form.start, endTime: form.end, wholeShiftAtHours: whole };
}

function WindowFields({
  idPrefix,
  kind,
  form,
  onChange,
}: {
  idPrefix: string;
  kind: DifferentialKind;
  form: WindowForm;
  onChange: (next: WindowForm) => void;
}) {
  const wholeId = `${idPrefix}-whole`;
  return (
    <>
      <Field id={`${idPrefix}-start`} label="Window start" compact>
        <input
          id={`${idPrefix}-start`}
          type="time"
          required
          value={form.start}
          onChange={(event) => onChange({ ...form, start: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field id={`${idPrefix}-end`} label="Window end" compact>
        <input
          id={`${idPrefix}-end`}
          type="time"
          required
          value={form.end}
          onChange={(event) => onChange({ ...form, end: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field
        id={wholeId}
        label="Whole shift when at least (hours)"
        hint="Empty pays only the hours inside the window."
        tip={kind === 'night' ? NIGHT_WHY : EVENING_WHY}
      >
        <input
          id={wholeId}
          type="number"
          min={0}
          step={0.25}
          value={form.whole}
          onChange={(event) => onChange({ ...form, whole: event.target.value })}
          className={`${INPUT} w-28`}
          aria-describedby={describedBy(wholeId, { hint: true })}
        />
      </Field>
    </>
  );
}

function describeAmount(d: Pick<Differential, 'mode' | 'amount'>): string {
  return d.mode === 'flat' ? `${formatDollars(d.amount, { cents: true })}/h` : `× ${d.amount}`;
}

function describeWindow(window: NonNullable<Differential['window']>): string {
  const whole =
    window.wholeShiftAtHours === null
      ? 'only the hours inside'
      : `whole shift from ${window.wholeShiftAtHours} h inside`;
  return `${window.startTime}–${window.endTime}, ${whole}`;
}

export function DifferentialsSection({ unitId }: { unitId: Id }) {
  const confirm = useConfirm();
  const query = useDifferentials(unitId);
  const create = useCreateDifferential(unitId);
  const update = useUpdateDifferential(unitId);
  const remove = useDeleteDifferential(unitId);

  const [kind, setKind] = useState<DifferentialKind>('night');
  const [mode, setMode] = useState<Differential['mode']>('flat');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<Id | undefined>(undefined);
  const [editAmount, setEditAmount] = useState('');
  const [byClock, setByClock] = useState(false);
  const [windowForm, setWindowForm] = useState<WindowForm>(EMPTY_WINDOW);
  const [editWindow, setEditWindow] = useState<WindowForm>(EMPTY_WINDOW);
  const [editError, setEditError] = useState<string | undefined>(undefined);

  if (query.isPending) return <AsyncState status="loading" label="Loading differentials" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load differentials" error={query.error} />;
  }

  const sorted = [...query.data].sort(
    (a, b) => DIFFERENTIAL_ORDER.indexOf(a.kind) - DIFFERENTIAL_ORDER.indexOf(b.kind),
  );

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Differentials</h2>
      <p className="mb-3 text-xs text-text-muted">
        Flat differentials add dollars per hour to the base rate; multipliers scale the rate after
        the flat ones are added, so a 1.5× holiday applies to base plus night plus charge.
      </p>

      <form
        className="mb-4 flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = Number(amount);
          if (!(parsed >= 0)) {
            setError('An amount is required');
            return;
          }
          // Evening has no flag to fall back on, so it is always by the clock.
          const clock = kind === 'evening' || (kind === 'night' && byClock);
          const window = clock ? windowOf(windowForm) : undefined;
          if (typeof window === 'string') {
            setError(window);
            return;
          }
          setError(undefined);
          create.mutate(
            { unitId, kind, mode, amount: parsed, active: true, ...(window ? { window } : {}) },
            {
              onSuccess: () => {
                setAmount('');
                setWindowForm(EMPTY_WINDOW);
              },
              onError: (e) => setError(e.message),
            },
          );
        }}
      >
        <label className={LABEL}>
          Kind
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as DifferentialKind)}
            className={INPUT}
            data-testid="differential-kind"
          >
            {DIFFERENTIAL_ORDER.map((k) => (
              <option key={k} value={k}>
                {COST_LINE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Mode
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as Differential['mode'])}
            className={INPUT}
          >
            <option value="flat">Flat $ per hour</option>
            <option value="multiplier">Multiplier</option>
          </select>
        </label>
        <label className={LABEL}>
          {mode === 'flat' ? 'Dollars per hour' : 'Multiplier'}
          <input
            type="number"
            min={0}
            step={0.01}
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={`${INPUT} w-28`}
            data-testid="differential-amount"
          />
        </label>
        {kind === 'night' ? (
          <label className={`${LABEL} flex-row items-center gap-2`}>
            <input
              type="checkbox"
              checked={byClock}
              onChange={(event) => setByClock(event.target.checked)}
            />
            By clock time
          </label>
        ) : null}
        {kind === 'evening' || (kind === 'night' && byClock) ? (
          <WindowFields
            idPrefix="differential"
            kind={kind}
            form={windowForm}
            onChange={setWindowForm}
          />
        ) : null}
        <button type="submit" className={PRIMARY} disabled={create.isPending}>
          Add differential
        </button>
        {error !== undefined ? <span className="text-xs text-danger">{error}</span> : null}
      </form>

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table
          className="w-full min-w-[520px] border-collapse text-sm"
          data-testid="differential-table"
        >
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className={TH}>
                Differential
              </th>
              <th scope="col" className={TH}>
                Amount
              </th>
              <th scope="col" className={TH}>
                Active
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                  No differentials — every shift prices at base rate.
                </td>
              </tr>
            ) : (
              sorted.map((d) => (
                <tr
                  key={d.id}
                  className={`border-b border-border last:border-0 ${d.active ? '' : 'opacity-60'}`}
                >
                  <td className={TD}>
                    <span className="font-medium">{COST_LINE_LABELS[d.kind]}</span>
                    <span className="block text-xs text-text-muted">
                      {DIFFERENTIAL_HELP[d.kind]}
                    </span>
                    {d.window ? (
                      <span className="block text-xs text-text-muted">
                        By clock time: {describeWindow(d.window)}
                      </span>
                    ) : null}
                  </td>
                  <td className={TD}>
                    {editingId === d.id ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={editAmount}
                          onChange={(event) => setEditAmount(event.target.value)}
                          className={`${INPUT} w-24`}
                          aria-label="Amount"
                        />
                        {takesWindow(d.kind) ? (
                          <>
                            {d.kind === 'night' ? (
                              <label className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={editWindow.start !== '' || editWindow.end !== ''}
                                  onChange={(event) =>
                                    setEditWindow(
                                      event.target.checked
                                        ? { start: '18:00', end: '06:00', whole: '' }
                                        : EMPTY_WINDOW,
                                    )
                                  }
                                />
                                By clock time
                              </label>
                            ) : null}
                            {editWindow.start !== '' ||
                            editWindow.end !== '' ||
                            d.kind === 'evening' ? (
                              <WindowFields
                                idPrefix={`differential-${d.id}`}
                                kind={d.kind}
                                form={editWindow}
                                onChange={setEditWindow}
                              />
                            ) : null}
                          </>
                        ) : null}
                        {editError !== undefined ? (
                          <span className="text-xs text-danger">{editError}</span>
                        ) : null}
                      </div>
                    ) : (
                      describeAmount(d)
                    )}
                  </td>
                  <td className={TD}>
                    <input
                      type="checkbox"
                      checked={d.active}
                      aria-label={`${COST_LINE_LABELS[d.kind]} active`}
                      onChange={(event) =>
                        update.mutate({ id: d.id, patch: { active: event.target.checked } })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {editingId === d.id ? (
                        <>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => {
                              const parsed = Number(editAmount);
                              if (!(parsed >= 0)) return;
                              const clock =
                                takesWindow(d.kind) &&
                                (editWindow.start !== '' || editWindow.end !== '');
                              const window = clock ? windowOf(editWindow) : null;
                              if (typeof window === 'string') {
                                setEditError(window);
                                return;
                              }
                              if (d.kind === 'evening' && window === null) {
                                setEditError('An evening differential needs a window');
                                return;
                              }
                              setEditError(undefined);
                              update.mutate(
                                {
                                  id: d.id,
                                  patch: takesWindow(d.kind)
                                    ? { amount: parsed, window }
                                    : { amount: parsed },
                                },
                                {
                                  onSuccess: () => setEditingId(undefined),
                                  onError: (e) => setEditError(e.message),
                                },
                              );
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => setEditingId(undefined)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={SMALL}
                            onClick={() => {
                              setEditingId(d.id);
                              setEditAmount(String(d.amount));
                              setEditWindow(windowFormOf(d.window));
                              setEditError(undefined);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className={SMALL_DANGER}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Delete the ${COST_LINE_LABELS[d.kind]}?`,
                                  confirmLabel: 'Delete',
                                })
                              ) {
                                remove.mutate(d.id);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
