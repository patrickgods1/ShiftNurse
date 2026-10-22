/**
 * Shift differentials: nights, weekends, holidays, consecutive shifts, short rest, charge — flat or
 * percentage, switchable.
 */

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
import { useUnsavedChanges } from '../../../components/unsaved-changes.js';
import { parseNumberField } from '../../../field-values.js';
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
  consecutive_shift:
    'Every further shift once a run of days in a row holds more full shifts than the contract allows, until a day off',
  short_rest:
    'A shift that starts too soon after the last one ended, on the whole shift or only the hours before the rest would have ended',
  charge: 'Shifts where the nurse is the charge nurse',
  on_call: 'Standby hours — paid instead of base pay, not on top of it',
  call_back: 'Being called in while on standby (priced by the day-of console)',
  agency: 'Every worked shift of an agency nurse',
};

const NIGHT_WHY =
  'Under the VA rule (38 U.S.C. §7453(b)) the night differential is 10% on the whole tour when at least 4 hours fall between 6 pm and 6 am, and otherwise only on the hours inside that window. Set the window to 18:00–06:00 and the whole-shift hours to 4. Leave the whole-shift hours empty to pay only the hours inside the window.';
const EVENING_WHY =
  'Many contracts pay an evening differential for the hours inside a clock window such as 15:00–23:00. Leave the whole-shift hours empty to pay only those hours, or enter a number to pay the whole shift once that many hours fall in the window.';

const CONSECUTIVE_WHY =
  'UC–CNA 2025–2030 § G.3 pays 1.5× once a nurse works more than six full 8-hour shifts within six days, five 10s within five, or four 12s within four, until she has a day off (a nurse may waive it, § G.2). Without tiers a run counts 12-hour shifts only: enter 4 and 4 with a 1.5 multiplier. Standby and leave never count toward the run.';

const TIERS_WHY =
  'UC–CNA 2025–2030 § G.3 counts 8- and 10-hour runs too: more than six full 8s within six days, five 10s within five, or four 12s within four. Add a tier for each: 8 with 6 and 6, 10 with 5 and 5, 12 with 4 and 4. A shift counts toward every tier whose hours it reaches, and the premium starts as soon as any tier is passed. It is still paid once.';

/** The most tiers a premium holds: § G.3 has three, 8s, 10s and 12s. */
const MAX_TIERS = 3;

interface TierForm {
  hours: string;
  after: string;
  within: string;
}
interface ConsecutiveForm {
  tiers: TierForm[];
}
const EMPTY_TIER: TierForm = { hours: '12', after: '', within: '' };
const EMPTY_CONSECUTIVE: ConsecutiveForm = { tiers: [EMPTY_TIER] };

function consecutiveFormOf(consecutive: Differential['consecutive']): ConsecutiveForm {
  if (consecutive === undefined) return EMPTY_CONSECUTIVE;
  // A premium saved without tiers is the 12-hour tier, which is how costing reads it too.
  const tiers = consecutive.tiers ?? [
    {
      fullShiftHours: 12,
      afterShifts: consecutive.afterShifts,
      withinDays: consecutive.withinDays,
    },
  ];
  return {
    tiers: tiers.map((t) => ({
      hours: String(t.fullShiftHours),
      after: String(t.afterShifts),
      within: String(t.withinDays),
    })),
  };
}

/** The trigger the form describes, or the reason it cannot be saved. */
function consecutiveOf(form: ConsecutiveForm): NonNullable<Differential['consecutive']> | string {
  const tiers: { fullShiftHours: number; afterShifts: number; withinDays: number }[] = [];
  for (const tier of form.tiers) {
    if (tier.after.trim() === '' || tier.within.trim() === '') {
      return 'Enter both the number of shifts and the number of days';
    }
    if (tier.hours.trim() === '') return 'Enter the hours of a full shift';
    const fullShiftHours = Number(tier.hours);
    const afterShifts = Number(tier.after);
    const withinDays = Number(tier.within);
    if (![fullShiftHours, afterShifts, withinDays].every((n) => Number.isInteger(n) && n >= 1)) {
      return 'Hours, shifts and days must be whole numbers of at least 1';
    }
    tiers.push({ fullShiftHours, afterShifts, withinDays });
  }
  if (new Set(tiers.map((t) => t.fullShiftHours)).size !== tiers.length) {
    return 'Each tier needs its own full-shift hours';
  }
  const first = tiers[0];
  if (first === undefined) return 'Enter both the number of shifts and the number of days';
  // One 12-hour tier is the reading every premium had before tiers: saved without them, so a
  // unit that never touches tiers stores exactly what it did.
  if (tiers.length === 1 && first.fullShiftHours === 12) {
    return { afterShifts: first.afterShifts, withinDays: first.withinDays };
  }
  // With tiers the top-level numbers are not read; they keep the 12-hour tier's, else the first's.
  const twelve = tiers.find((t) => t.fullShiftHours === 12) ?? first;
  return { afterShifts: twelve.afterShifts, withinDays: twelve.withinDays, tiers };
}

function ConsecutiveFields({
  idPrefix,
  form,
  onChange,
}: {
  idPrefix: string;
  form: ConsecutiveForm;
  onChange: (next: ConsecutiveForm) => void;
}) {
  const several = form.tiers.length > 1;
  const setTier = (index: number, next: TierForm) =>
    onChange({ tiers: form.tiers.map((t, i) => (i === index ? next : t)) });
  return (
    <div className="flex flex-col gap-2">
      {form.tiers.map((tier, index) => {
        // Labels stay plain with one tier; with several each names its tier, so none is ambiguous.
        const label = (text: string) => (several ? `Tier ${index + 1}: ${text}` : text);
        const rowId = `${idPrefix}-tier-${index}`;
        const hoursId = `${rowId}-hours`;
        const afterId = index === 0 ? `${idPrefix}-after-shifts` : `${rowId}-after-shifts`;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tier rows have no identity but position.
          <div key={index} className="flex flex-wrap items-end gap-2">
            <Field
              id={hoursId}
              label={label('Full shift (hours)')}
              hint={
                index === 0
                  ? 'A shift scheduled for at least this many hours counts toward the run.'
                  : undefined
              }
              tip={index === 0 ? TIERS_WHY : undefined}
            >
              <input
                id={hoursId}
                type="number"
                min={1}
                step={1}
                required
                value={tier.hours}
                onChange={(event) => setTier(index, { ...tier, hours: event.target.value })}
                className={`${INPUT} w-24`}
                aria-describedby={describedBy(hoursId, { hint: index === 0 })}
              />
            </Field>
            <Field
              id={afterId}
              label={label('More than (full shifts)')}
              hint={
                index === 0
                  ? 'A shift counts the full shifts on its own day and the days before it, so 12, 4 and 4 pays the fifth 12 in a row, and every shift after until a date with no shift.'
                  : undefined
              }
              tip={index === 0 ? CONSECUTIVE_WHY : undefined}
            >
              <input
                id={afterId}
                type="number"
                min={1}
                step={1}
                required
                value={tier.after}
                onChange={(event) => setTier(index, { ...tier, after: event.target.value })}
                className={`${INPUT} w-24`}
                aria-describedby={describedBy(afterId, { hint: index === 0 })}
              />
            </Field>
            <Field id={`${rowId}-within-days`} label={label('Within (days)')} compact>
              <input
                id={`${rowId}-within-days`}
                type="number"
                min={1}
                step={1}
                required
                value={tier.within}
                onChange={(event) => setTier(index, { ...tier, within: event.target.value })}
                className={`${INPUT} w-24`}
              />
            </Field>
            {several ? (
              <button
                type="button"
                className={SMALL}
                onClick={() => onChange({ tiers: form.tiers.filter((_, i) => i !== index) })}
              >
                Remove tier {index + 1}
              </button>
            ) : null}
          </div>
        );
      })}
      {form.tiers.length < MAX_TIERS ? (
        <button
          type="button"
          className={`${SMALL} self-start`}
          onClick={() => onChange({ tiers: [...form.tiers, { hours: '', after: '', within: '' }] })}
        >
          Add a tier
        </button>
      ) : null}
    </div>
  );
}

const SHORT_REST_WHY =
  'UC–CNA 2025–2030 Art. 14 § N.1 pays time and a half for "a work period not preceded by at least six (6) hours off": enter 6, the whole shift, and a 1.5 multiplier. WSNA § 7.10 contracts often pay only the hours worked before the rest would have ended. Rest is counted from the end of the last worked shift, holdover included; standby and call-backs do not count (§ N.3), and a rest waiver does not take the premium away.';

interface ShortRestForm {
  hours: string;
  scope: NonNullable<Differential['shortRest']>['scope'];
}
const EMPTY_SHORT_REST: ShortRestForm = { hours: '', scope: 'whole_shift' };

function shortRestFormOf(shortRest: Differential['shortRest']): ShortRestForm {
  return shortRest === undefined
    ? EMPTY_SHORT_REST
    : { hours: String(shortRest.minHoursOff), scope: shortRest.scope };
}

/** The trigger the form describes, or the reason it cannot be saved. */
function shortRestOf(form: ShortRestForm): NonNullable<Differential['shortRest']> | string {
  const hours = parseNumberField(form.hours);
  if (hours === undefined) return 'Enter the hours off the contract asks for';
  if (!(hours > 0) || hours > 24) return 'Hours off must be more than 0 and at most 24';
  return { minHoursOff: hours, scope: form.scope };
}

function ShortRestFields({
  idPrefix,
  form,
  onChange,
}: {
  idPrefix: string;
  form: ShortRestForm;
  onChange: (next: ShortRestForm) => void;
}) {
  const hoursId = `${idPrefix}-hours-off`;
  const scopeId = `${idPrefix}-short-rest-scope`;
  return (
    <>
      <Field
        id={hoursId}
        label="Less than (hours off)"
        hint="A shift starting sooner than this after the last one ended earns the premium."
        tip={SHORT_REST_WHY}
      >
        <input
          id={hoursId}
          type="number"
          min={0.25}
          max={24}
          step={0.25}
          required
          value={form.hours}
          onChange={(event) => onChange({ ...form, hours: event.target.value })}
          className={`${INPUT} w-24`}
          aria-describedby={describedBy(hoursId, { hint: true })}
        />
      </Field>
      <Field id={scopeId} label="Paid on" compact>
        <select
          id={scopeId}
          value={form.scope}
          onChange={(event) =>
            onChange({ ...form, scope: event.target.value as ShortRestForm['scope'] })
          }
          className={INPUT}
        >
          <option value="whole_shift">The whole shift</option>
          <option value="within_window">Only the hours before the rest would have ended</option>
        </select>
      </Field>
    </>
  );
}

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

/**
 * The lowest amount the cost engine prices without taking pay away: a multiplier adds
 * `base * (amount - 1)`, so below 1 it subtracts. On-call standby is paid instead of base at
 * `base * amount`, so 0.15 (the VA's 15% of basic pay) is a real rate. The repository refuses the
 * same; checking here says so before the round trip.
 */
function minimumAmount(kind: DifferentialKind, mode: Differential['mode']): number {
  return mode === 'multiplier' && kind !== 'on_call' ? 1 : 0;
}

/** The amount the form describes, or the reason it cannot be saved. */
function amountOf(
  kind: DifferentialKind,
  mode: Differential['mode'],
  text: string,
): number | string {
  const amount = parseNumberField(text);
  if (amount === undefined) return 'Enter an amount.';
  if (amount < minimumAmount(kind, mode)) {
    return mode === 'multiplier' && kind !== 'on_call'
      ? 'A multiplier must be at least 1 (1.5 is time and a half).'
      : 'Enter an amount of zero or more.';
  }
  return amount;
}

function describeConsecutive(consecutive: NonNullable<Differential['consecutive']>): string {
  if (consecutive.tiers === undefined) {
    return `after more than ${consecutive.afterShifts} full shifts within ${consecutive.withinDays} days, until a day off`;
  }
  const tiers = consecutive.tiers
    .map((t) => `${t.afterShifts} ${t.fullShiftHours}-hour shifts within ${t.withinDays} days`)
    .join(', or ');
  return `after more than ${tiers}, until a day off`;
}

function describeShortRest(shortRest: NonNullable<Differential['shortRest']>): string {
  return shortRest.scope === 'whole_shift'
    ? `on the whole shift after less than ${shortRest.minHoursOff} hours off`
    : `on the hours worked within ${shortRest.minHoursOff} hours of the last shift's end`;
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
  // Its own mutation so a refused Active tick is shown apart from the inline edit's error.
  const toggle = useUpdateDifferential(unitId);
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
  const [consecutiveForm, setConsecutiveForm] = useState<ConsecutiveForm>(EMPTY_CONSECUTIVE);
  const [editConsecutive, setEditConsecutive] = useState<ConsecutiveForm>(EMPTY_CONSECUTIVE);
  const [shortRestForm, setShortRestForm] = useState<ShortRestForm>(EMPTY_SHORT_REST);
  const [editShortRest, setEditShortRest] = useState<ShortRestForm>(EMPTY_SHORT_REST);
  const [editError, setEditError] = useState<string | undefined>(undefined);

  // Field by field, not by reference: the forms are fresh objects after every keystroke.
  const sameWindow = (a: WindowForm, b: WindowForm) =>
    a.start === b.start && a.end === b.end && a.whole === b.whole;
  const sameConsecutive = (a: ConsecutiveForm, b: ConsecutiveForm) =>
    a.tiers.length === b.tiers.length &&
    a.tiers.every((t, i) => {
      const u = b.tiers[i];
      return u !== undefined && t.hours === u.hours && t.after === u.after && t.within === u.within;
    });
  const sameShortRest = (a: ShortRestForm, b: ShortRestForm) =>
    a.hours === b.hours && a.scope === b.scope;
  const editedRow = query.data?.find((d) => d.id === editingId);
  useUnsavedChanges(
    'Differentials',
    editedRow !== undefined &&
      (editAmount !== String(editedRow.amount) ||
        !sameWindow(editWindow, windowFormOf(editedRow.window)) ||
        !sameConsecutive(editConsecutive, consecutiveFormOf(editedRow.consecutive)) ||
        !sameShortRest(editShortRest, shortRestFormOf(editedRow.shortRest))),
  );
  useUnsavedChanges(
    'New differential',
    amount !== '' ||
      !sameWindow(windowForm, EMPTY_WINDOW) ||
      !sameConsecutive(consecutiveForm, EMPTY_CONSECUTIVE) ||
      !sameShortRest(shortRestForm, EMPTY_SHORT_REST),
  );

  if (query.isPending) return <AsyncState status="loading" label="Loading differentials" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load differentials" error={query.error} />;
  }

  const sorted = [...query.data].sort(
    (a, b) => DIFFERENTIAL_ORDER.indexOf(a.kind) - DIFFERENTIAL_ORDER.indexOf(b.kind),
  );
  // Rows saved before the repository refused duplicates. Costing pays the first by rowid, which
  // the renderer cannot see, so the badge names no winner.
  const activeOfKind = new Map<DifferentialKind, number>();
  for (const d of query.data) {
    if (d.active) activeOfKind.set(d.kind, (activeOfKind.get(d.kind) ?? 0) + 1);
  }

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
          const parsed = amountOf(kind, mode, amount);
          if (typeof parsed === 'string') {
            setError(parsed);
            return;
          }
          // Evening has no flag to fall back on, so it is always by the clock.
          const clock = kind === 'evening' || (kind === 'night' && byClock);
          const window = clock ? windowOf(windowForm) : undefined;
          if (typeof window === 'string') {
            setError(window);
            return;
          }
          // Like evening, the consecutive-shift premium has nothing to go on without its trigger.
          const consecutive =
            kind === 'consecutive_shift' ? consecutiveOf(consecutiveForm) : undefined;
          if (typeof consecutive === 'string') {
            setError(consecutive);
            return;
          }
          const shortRest = kind === 'short_rest' ? shortRestOf(shortRestForm) : undefined;
          if (typeof shortRest === 'string') {
            setError(shortRest);
            return;
          }
          setError(undefined);
          create.mutate(
            {
              unitId,
              kind,
              mode,
              amount: parsed,
              active: true,
              ...(window ? { window } : {}),
              ...(consecutive ? { consecutive } : {}),
              ...(shortRest ? { shortRest } : {}),
            },
            {
              onSuccess: () => {
                setAmount('');
                setWindowForm(EMPTY_WINDOW);
                setConsecutiveForm(EMPTY_CONSECUTIVE);
                setShortRestForm(EMPTY_SHORT_REST);
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
            min={minimumAmount(kind, mode)}
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
        {kind === 'consecutive_shift' ? (
          <ConsecutiveFields
            idPrefix="differential"
            form={consecutiveForm}
            onChange={setConsecutiveForm}
          />
        ) : null}
        {kind === 'short_rest' ? (
          <ShortRestFields
            idPrefix="differential"
            form={shortRestForm}
            onChange={setShortRestForm}
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
                    {d.consecutive ? (
                      <span className="block text-xs text-text-muted">
                        Paid {describeConsecutive(d.consecutive)}
                      </span>
                    ) : null}
                    {d.shortRest ? (
                      <span className="block text-xs text-text-muted">
                        Paid {describeShortRest(d.shortRest)}
                      </span>
                    ) : null}
                    {d.active && (activeOfKind.get(d.kind) ?? 0) > 1 ? (
                      <span className="block text-xs text-warn">
                        Two active {COST_LINE_LABELS[d.kind].toLowerCase()}s: only one is paid. Turn
                        one off.
                      </span>
                    ) : null}
                  </td>
                  <td className={TD}>
                    {editingId === d.id ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="number"
                          min={minimumAmount(d.kind, d.mode)}
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
                        {d.kind === 'consecutive_shift' ? (
                          <ConsecutiveFields
                            idPrefix={`differential-${d.id}`}
                            form={editConsecutive}
                            onChange={setEditConsecutive}
                          />
                        ) : null}
                        {d.kind === 'short_rest' ? (
                          <ShortRestFields
                            idPrefix={`differential-${d.id}`}
                            form={editShortRest}
                            onChange={setEditShortRest}
                          />
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
                        toggle.mutate({ id: d.id, patch: { active: event.target.checked } })
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
                              const parsed = amountOf(d.kind, d.mode, editAmount);
                              if (typeof parsed === 'string') {
                                setEditError(parsed);
                                return;
                              }
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
                              const consecutive =
                                d.kind === 'consecutive_shift'
                                  ? consecutiveOf(editConsecutive)
                                  : undefined;
                              if (typeof consecutive === 'string') {
                                setEditError(consecutive);
                                return;
                              }
                              const shortRest =
                                d.kind === 'short_rest' ? shortRestOf(editShortRest) : undefined;
                              if (typeof shortRest === 'string') {
                                setEditError(shortRest);
                                return;
                              }
                              setEditError(undefined);
                              update.mutate(
                                {
                                  id: d.id,
                                  patch: takesWindow(d.kind)
                                    ? { amount: parsed, window }
                                    : consecutive
                                      ? { amount: parsed, consecutive }
                                      : shortRest
                                        ? { amount: parsed, shortRest }
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
                              setEditConsecutive(consecutiveFormOf(d.consecutive));
                              setEditShortRest(shortRestFormOf(d.shortRest));
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
      {toggle.error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {toggle.error.message}
        </p>
      ) : null}
    </section>
  );
}
