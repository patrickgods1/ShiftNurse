/**
 * Settings › Leave: which FMLA the unit's employer is under, when its leave year turns over, and
 * how each kind of balance grows. The request dialogs read it to carry payroll's balance forward
 * to the day a request starts and to count FMLA the way the employer does (a VA unit is under
 * Title 5, not Title I). A unit that has set nothing is read as the default: Title I, a rolling
 * 12 months back, and no accrual — balances are then exactly what payroll gave.
 *
 * The form holds text for every number so a half-typed value is not lost, and turns it into a
 * `LeavePolicy` only to save. What makes a policy unusable (tiers out of order, a fixed year with
 * no start) is the validator's call in main; its message is shown as it was written.
 */

import {
  DEFAULT_LEAVE_POLICY,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  type EmploymentType,
  type FmlaRegime,
  type FmlaYearMethod,
  LEAVE_BALANCE_TYPES,
  type LeaveBalanceType,
  type LeavePolicy,
  type LeaveYearStart,
  type NurseRole,
  TIME_OFF_TYPE_LABELS,
} from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useUpdateUnit } from '../../api-setup.js';
import { EditorShell } from '../../components/editor-shell.js';
import { CheckField, describedBy, Field } from '../../components/field-help.js';
import { INPUT, SECONDARY, SMALL, SMALL_DANGER } from '../../components/ui.js';
import { useUnit } from '../../unit-context.js';

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];

const YEAR_METHODS: { value: FmlaYearMethod; label: string }[] = [
  { value: 'rolling_backward', label: 'Rolling, back from the first day of leave' },
  { value: 'rolling_forward', label: 'Forward from first use' },
  { value: 'calendar', label: 'Calendar year' },
  { value: 'fixed', label: 'Fixed year' },
];

interface TierDraft {
  from: string;
  mode: 'period' | 'hour';
  rate: string;
}

interface RuleDraft {
  /** React's key: rules reorder, and an index would hand one rule's inputs to another. */
  key: number;
  balanceType: LeaveBalanceType;
  roles: NurseRole[];
  employmentTypes: EmploymentType[];
  tiers: TierDraft[];
  balanceCap: string;
  carryoverCap: string;
  useCap: string;
  frontLoad: string;
  citation: string;
}

interface Draft {
  regime: FmlaRegime;
  yearMethod: FmlaYearMethod;
  fixedYearStart: string;
  leaveYearStart: LeaveYearStart;
  rules: RuleDraft[];
}

let nextKey = 1;

function draftFrom(policy: LeavePolicy): Draft {
  return {
    regime: policy.fmla.regime,
    yearMethod: policy.fmla.yearMethod,
    fixedYearStart: policy.fmla.fixedYearStart ?? '',
    leaveYearStart: policy.leaveYearStart,
    rules: policy.accrual.map((r) => ({
      key: nextKey++,
      balanceType: r.balanceType,
      roles: [...(r.roles ?? [])],
      employmentTypes: [...(r.employmentTypes ?? [])],
      tiers: r.tiers.map((t) => ({
        from: String(t.fromYearsOfService),
        mode: t.hoursPerAccruedHour !== undefined ? 'hour' : 'period',
        rate: String(t.hoursPerAccruedHour ?? t.hoursPerPayPeriod ?? ''),
      })),
      balanceCap: r.balanceCapHours === undefined ? '' : String(r.balanceCapHours),
      carryoverCap: r.carryoverCapHours === undefined ? '' : String(r.carryoverCapHours),
      useCap: r.useCapHoursPerYear === undefined ? '' : String(r.useCapHoursPerYear),
      frontLoad: r.frontLoadHours === undefined ? '' : String(r.frontLoadHours),
      citation: r.citation ?? '',
    })),
  };
}

const isNumber = (text: string) => text.trim() !== '' && Number.isFinite(Number(text));

/** Fields that cannot be turned into a number yet; blank caps and a blank rate are legal to send. */
function problemsIn(draft: Draft): string[] {
  const out: string[] = [];
  draft.rules.forEach((rule, i) => {
    const label = `Rule ${i + 1}`;
    for (const [n, tier] of rule.tiers.entries()) {
      if (!isNumber(tier.from)) out.push(`${label}, tier ${n + 1}: enter the years of service.`);
      if (tier.rate.trim() !== '' && !isNumber(tier.rate)) {
        out.push(`${label}, tier ${n + 1}: the rate must be a number.`);
      }
    }
    for (const [name, value] of [
      ['balance cap', rule.balanceCap],
      ['carryover cap', rule.carryoverCap],
      ['yearly use cap', rule.useCap],
      ['front-loaded amount', rule.frontLoad],
    ] as const) {
      if (value.trim() !== '' && !isNumber(value))
        out.push(`${label}: the ${name} must be a number.`);
    }
  });
  return out;
}

/** Call only when `problemsIn` is empty. */
function policyFrom(draft: Draft): LeavePolicy {
  // Title 5 always counts the year forward from first use, whatever the select last held.
  const yearMethod: FmlaYearMethod =
    draft.regime === 'title5' ? 'rolling_forward' : draft.yearMethod;
  return {
    fmla: {
      regime: draft.regime,
      yearMethod,
      ...(yearMethod === 'fixed' ? { fixedYearStart: draft.fixedYearStart.trim() } : {}),
    },
    leaveYearStart: draft.leaveYearStart,
    accrual: draft.rules.map((r) => ({
      balanceType: r.balanceType,
      ...(r.roles.length > 0 ? { roles: r.roles } : {}),
      ...(r.employmentTypes.length > 0 ? { employmentTypes: r.employmentTypes } : {}),
      // A front-loaded rule needs no earning rate, so a tier left without one is not sent; the
      // validator would refuse it as a tier with no rate.
      tiers: (r.frontLoad.trim() === ''
        ? r.tiers
        : r.tiers.filter((t) => t.rate.trim() !== '')
      ).map((t) => ({
        fromYearsOfService: Number(t.from),
        ...(t.rate.trim() === ''
          ? {}
          : t.mode === 'hour'
            ? { hoursPerAccruedHour: Number(t.rate) }
            : { hoursPerPayPeriod: Number(t.rate) }),
      })),
      ...(r.balanceCap.trim() !== '' ? { balanceCapHours: Number(r.balanceCap) } : {}),
      ...(r.carryoverCap.trim() !== '' ? { carryoverCapHours: Number(r.carryoverCap) } : {}),
      ...(r.useCap.trim() !== '' ? { useCapHoursPerYear: Number(r.useCap) } : {}),
      ...(r.frontLoad.trim() !== '' ? { frontLoadHours: Number(r.frontLoad) } : {}),
      ...(r.citation.trim() !== '' ? { citation: r.citation.trim() } : {}),
    })),
  };
}

/** The draft without React's keys, so two drafts compare by what they say. */
const fingerprint = (draft: Draft) =>
  JSON.stringify({ ...draft, rules: draft.rules.map(({ key: _key, ...rule }) => rule) });

function blankRule(): RuleDraft {
  return {
    key: nextKey++,
    balanceType: 'annual',
    roles: [],
    employmentTypes: [],
    tiers: [{ from: '0', mode: 'period', rate: '' }],
    balanceCap: '',
    carryoverCap: '',
    useCap: '',
    frontLoad: '',
    citation: '',
  };
}

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export default function LeavePanel() {
  const unit = useUnit();
  const update = useUpdateUnit();
  const saved = unit.leavePolicy ?? DEFAULT_LEAVE_POLICY;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(saved));
  const savedFingerprint = fingerprint(draftFrom(saved));

  // Follow the saved policy: after Save, Use the default, or switching unit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` is read through its fingerprint.
  useEffect(() => {
    setDraft(draftFrom(saved));
  }, [unit.id, savedFingerprint]);

  const problems = problemsIn(draft);
  const dirty = fingerprint(draft) !== savedFingerprint;
  const title5 = draft.regime === 'title5';

  const patch = (changes: Partial<Draft>) => setDraft((d) => ({ ...d, ...changes }));
  const patchRule = (key: number, changes: Partial<RuleDraft>) =>
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.key === key ? { ...r, ...changes } : r)),
    }));
  const move = (index: number, by: -1 | 1) =>
    setDraft((d) => {
      const rules = [...d.rules];
      const [rule] = rules.splice(index, 1);
      rules.splice(index + by, 0, rule!);
      return { ...d, rules };
    });

  const submit = () => {
    if (problems.length > 0) return;
    update.mutate({ id: unit.id, patch: { leavePolicy: policyFrom(draft) } });
  };
  const discard = () => {
    setDraft(draftFrom(saved));
    update.reset();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="leave-panel">
      <EditorShell
        label="Leave"
        dirty={dirty}
        saving={update.isPending}
        error={update.error}
        canSave={problems.length === 0}
        formId="leave-form"
        onSave={submit}
        onDiscard={discard}
      >
        <form
          id="leave-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <section className="rounded-md border border-border bg-surface p-4">
            <h2 className="mb-1 text-sm font-semibold text-text">Family and medical leave</h2>
            <p className="mb-3 text-sm text-text-muted">
              {unit.leavePolicy === undefined
                ? 'This unit has no leave policy, so it is read as the default: Title I, a rolling 12 months back, and balances exactly as payroll gave them.'
                : 'Requests are measured the way this policy says.'}
            </p>
            <div className="grid max-w-xl grid-cols-2 gap-3">
              <Field
                id="leave-regime"
                label="FMLA regime"
                hint="Federal staff, VA nurses included, are under Title 5; private and state employers are under Title I."
                tip="Title 5 has no 1,250-hour test and gives 6 × the biweekly tour (480 hours on an 80-hour pay period). Title I needs 1,250 hours worked and gives 12 of the nurse's usual weeks."
              >
                <select
                  id="leave-regime"
                  className={INPUT}
                  value={draft.regime}
                  aria-describedby={describedBy('leave-regime', { hint: true })}
                  onChange={(e) => patch({ regime: e.target.value as FmlaRegime })}
                >
                  <option value="title1">Title I</option>
                  <option value="title5">Title 5 (federal)</option>
                </select>
              </Field>
              <Field
                id="leave-year-method"
                label="FMLA year"
                hint={
                  title5
                    ? 'Fixed under Title 5: the 12 months start on the first day of leave (5 C.F.R. § 630.1203(c)).'
                    : 'How the employer measures the 12 months of leave.'
                }
                tip="A Title I employer picks one of four methods (29 C.F.R. § 825.200(b)) and applies it to everyone."
              >
                <select
                  id="leave-year-method"
                  className={INPUT}
                  disabled={title5}
                  value={title5 ? 'rolling_forward' : draft.yearMethod}
                  aria-describedby={describedBy('leave-year-method', { hint: true })}
                  onChange={(e) => patch({ yearMethod: e.target.value as FmlaYearMethod })}
                >
                  {YEAR_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              {!title5 && draft.yearMethod === 'fixed' ? (
                <Field
                  id="leave-fixed-start"
                  label="Fixed year starts on"
                  hint="Month and day, like 10-01 for a fiscal year."
                >
                  <input
                    id="leave-fixed-start"
                    className={`${INPUT} w-28`}
                    placeholder="MM-DD"
                    maxLength={5}
                    value={draft.fixedYearStart}
                    aria-describedby={describedBy('leave-fixed-start', { hint: true })}
                    onChange={(e) => patch({ fixedYearStart: e.target.value })}
                  />
                </Field>
              ) : null}
            </div>
          </section>

          <section className="rounded-md border border-border bg-surface p-4">
            <h2 className="mb-1 text-sm font-semibold text-text">Leave balances</h2>
            <Field
              id="leave-year-start"
              className="max-w-xl"
              label="Leave year starts"
              hint="When a carryover cap forfeits the hours above it."
              tip="Federal leave years start on the first full pay period of January (5 U.S.C. § 6302(a)); most other employers use 1 January."
            >
              <select
                id="leave-year-start"
                className={`${INPUT} w-72`}
                value={draft.leaveYearStart}
                aria-describedby={describedBy('leave-year-start', { hint: true })}
                onChange={(e) => patch({ leaveYearStart: e.target.value as LeaveYearStart })}
              >
                <option value="calendar">1 January</option>
                <option value="first_full_pay_period">First full pay period (federal)</option>
              </select>
            </Field>

            <h3 className="mt-4 text-sm font-semibold text-text">Accrual rules</h3>
            <p className="mb-3 text-xs text-text-muted">
              A nurse's balance grows by the first rule that matches their balance type, role and
              employment type, so put the most specific rule first. A nurse no rule matches earns
              nothing: the balance stays as payroll gave it.
            </p>
            {draft.rules.length === 0 ? (
              <p className="mb-3 text-xs text-text-muted">No accrual rules.</p>
            ) : (
              <ol className="mb-3 flex flex-col gap-3">
                {draft.rules.map((rule, i) => (
                  <RuleEditor
                    key={rule.key}
                    rule={rule}
                    n={i + 1}
                    first={i === 0}
                    last={i === draft.rules.length - 1}
                    onChange={(changes) => patchRule(rule.key, changes)}
                    onMove={(by) => move(i, by)}
                    onRemove={() =>
                      setDraft((d) => ({ ...d, rules: d.rules.filter((r) => r.key !== rule.key) }))
                    }
                  />
                ))}
              </ol>
            )}
            <button
              type="button"
              className={SECONDARY}
              onClick={() => setDraft((d) => ({ ...d, rules: [...d.rules, blankRule()] }))}
            >
              Add accrual rule
            </button>
          </section>

          {problems.length > 0 ? (
            <ul className="text-xs text-danger" data-testid="leave-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {update.isSuccess && !dirty ? (
            <p role="status" className="text-sm text-success">
              Saved.
            </p>
          ) : null}
        </form>
      </EditorShell>

      <section className="rounded-md border border-border bg-surface p-4">
        <h2 className="mb-1 text-sm font-semibold text-text">Use the default</h2>
        <p className="mb-3 text-sm text-text-muted">
          Forget this unit's leave policy: FMLA is read as Title I with a rolling 12 months back,
          and balances are not carried forward.
        </p>
        <button
          type="button"
          className={SECONDARY}
          disabled={unit.leavePolicy === undefined || update.isPending}
          onClick={() => update.mutate({ id: unit.id, patch: { leavePolicy: null } })}
        >
          Use the default
        </button>
      </section>
    </div>
  );
}

function RuleEditor({
  rule,
  n,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RuleDraft;
  n: number;
  first: boolean;
  last: boolean;
  onChange(changes: Partial<RuleDraft>): void;
  onMove(by: -1 | 1): void;
  onRemove(): void;
}) {
  const id = `leave-rule-${rule.key}`;
  const patchTier = (index: number, changes: Partial<TierDraft>) =>
    onChange({ tiers: rule.tiers.map((t, k) => (k === index ? { ...t, ...changes } : t)) });

  return (
    <li>
      <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-semibold text-text">Rule {n}</legend>
        <div className="flex flex-wrap items-end gap-3">
          <Field id={`${id}-type`} label={`Rule ${n} balance`} compact>
            <select
              id={`${id}-type`}
              className={INPUT}
              value={rule.balanceType}
              onChange={(e) => onChange({ balanceType: e.target.value as LeaveBalanceType })}
            >
              {LEAVE_BALANCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TIME_OFF_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              className={SMALL}
              disabled={first}
              aria-label={`Move rule ${n} up`}
              onClick={() => onMove(-1)}
            >
              Move up
            </button>
            <button
              type="button"
              className={SMALL}
              disabled={last}
              aria-label={`Move rule ${n} down`}
              onClick={() => onMove(1)}
            >
              Move down
            </button>
            <button
              type="button"
              className={SMALL_DANGER}
              aria-label={`Remove rule ${n}`}
              onClick={onRemove}
            >
              Remove
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-6">
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-text-muted">Roles (none ticked: all)</legend>
            <div className="flex gap-3">
              {ROLES.map((role) => (
                <CheckField key={role} id={`${id}-role-${role}`} label={`Rule ${n} ${role}`}>
                  <input
                    id={`${id}-role-${role}`}
                    type="checkbox"
                    checked={rule.roles.includes(role)}
                    onChange={() => onChange({ roles: toggle(rule.roles, role) })}
                  />
                </CheckField>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-text-muted">Employment types (none ticked: all)</legend>
            <div className="flex flex-wrap gap-3">
              {EMPLOYMENT_TYPES.map((type) => (
                <CheckField
                  key={type}
                  id={`${id}-emp-${type}`}
                  label={`Rule ${n} ${EMPLOYMENT_TYPE_LABELS[type]}`}
                >
                  <input
                    id={`${id}-emp-${type}`}
                    type="checkbox"
                    checked={rule.employmentTypes.includes(type)}
                    onChange={() =>
                      onChange({ employmentTypes: toggle(rule.employmentTypes, type) })
                    }
                  />
                </CheckField>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs text-text-muted">
            Tiers: the last one a nurse's years of service have reached applies
          </legend>
          {rule.tiers.map((tier, k) => {
            const label = `Rule ${n} tier ${k + 1}`;
            return (
              // Tiers are edited in place and never reordered, so their position is their identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <div key={k} className="flex flex-wrap items-end gap-2">
                <Field id={`${id}-tier-${k}-from`} label={`${label} from years`} compact>
                  <input
                    id={`${id}-tier-${k}-from`}
                    type="number"
                    min={0}
                    step={1}
                    className={`${INPUT} w-20`}
                    value={tier.from}
                    onChange={(e) => patchTier(k, { from: e.target.value })}
                  />
                </Field>
                <Field id={`${id}-tier-${k}-mode`} label={`${label} earns`} compact>
                  <select
                    id={`${id}-tier-${k}-mode`}
                    className={INPUT}
                    value={tier.mode}
                    onChange={(e) => patchTier(k, { mode: e.target.value as TierDraft['mode'] })}
                  >
                    <option value="period">Hours per pay period</option>
                    <option value="hour">1 h per N h worked</option>
                  </select>
                </Field>
                <Field
                  id={`${id}-tier-${k}-rate`}
                  label={tier.mode === 'hour' ? `${label} N (hours worked)` : `${label} hours`}
                  compact
                >
                  <input
                    id={`${id}-tier-${k}-rate`}
                    type="number"
                    min={0}
                    step="any"
                    className={`${INPUT} w-24`}
                    value={tier.rate}
                    onChange={(e) => patchTier(k, { rate: e.target.value })}
                  />
                </Field>
                <button
                  type="button"
                  className={SMALL_DANGER}
                  disabled={rule.tiers.length === 1}
                  aria-label={`Remove tier ${k + 1} of rule ${n}`}
                  onClick={() => onChange({ tiers: rule.tiers.filter((_, j) => j !== k) })}
                >
                  Remove tier
                </button>
              </div>
            );
          })}
          <div>
            <button
              type="button"
              className={SMALL}
              aria-label={`Add a tier to rule ${n}`}
              onClick={() => {
                const years = Number(rule.tiers.at(-1)?.from ?? 0);
                onChange({
                  tiers: [
                    ...rule.tiers,
                    {
                      from: String(Number.isFinite(years) ? years + 1 : 1),
                      mode: 'period',
                      rate: '',
                    },
                  ],
                });
              }}
            >
              Add tier
            </button>
          </div>
        </fieldset>

        <div className="grid max-w-xl grid-cols-2 gap-3">
          <Field
            id={`${id}-cap`}
            label={`Rule ${n} balance cap (hours)`}
            hint="The most the balance may hold; accrual stops there. Blank: no cap."
          >
            <input
              id={`${id}-cap`}
              aria-describedby={describedBy(`${id}-cap`, { hint: true })}
              type="number"
              min={0}
              step="any"
              className={INPUT}
              value={rule.balanceCap}
              onChange={(e) => onChange({ balanceCap: e.target.value })}
            />
          </Field>
          <Field
            id={`${id}-carry`}
            label={`Rule ${n} carryover cap (hours)`}
            hint="The most carried into a new leave year; the rest is forfeited. Blank: no cap."
          >
            <input
              id={`${id}-carry`}
              aria-describedby={describedBy(`${id}-carry`, { hint: true })}
              type="number"
              min={0}
              step="any"
              className={INPUT}
              value={rule.carryoverCap}
              onChange={(e) => onChange({ carryoverCap: e.target.value })}
            />
          </Field>
          <Field
            id={`${id}-use-cap`}
            label={`Rule ${n} yearly use cap (hours)`}
            hint="The most of this balance a nurse may use in a leave year. Blank: no cap."
            tip="California lets an employer cap paid sick leave used at 40 hours or 5 days a year (Lab. Code § 246(b)(1), (d)). A request past it is flagged, never refused."
          >
            <input
              id={`${id}-use-cap`}
              aria-describedby={describedBy(`${id}-use-cap`, { hint: true })}
              type="number"
              min={0}
              step="any"
              className={INPUT}
              value={rule.useCap}
              onChange={(e) => onChange({ useCap: e.target.value })}
            />
          </Field>
          <Field
            id={`${id}-front-load`}
            label={`Rule ${n} front-loaded each year (hours)`}
            hint="Set the balance to this at each leave-year start instead of accruing per pay period. Blank: accrue."
            tip="Lab. Code § 246(d) lets an employer give the year's sick leave up front. The balance held before is not carried, and per-hour tiers cannot be used beside it."
          >
            <input
              id={`${id}-front-load`}
              aria-describedby={describedBy(`${id}-front-load`, { hint: true })}
              type="number"
              min={0}
              step="any"
              className={INPUT}
              value={rule.frontLoad}
              onChange={(e) => onChange({ frontLoad: e.target.value })}
            />
          </Field>
        </div>
        <Field
          id={`${id}-citation`}
          label={`Rule ${n} citation`}
          hint="The provision the rule comes from, shown beside it."
        >
          <input
            id={`${id}-citation`}
            aria-describedby={describedBy(`${id}-citation`, { hint: true })}
            className={INPUT}
            value={rule.citation}
            onChange={(e) => onChange({ citation: e.target.value })}
          />
        </Field>
      </fieldset>
    </li>
  );
}
