/**
 * The body of each assisted-setup step: a one-click starting point above the real Settings
 * editor for the same data. The editor is the ordinary one — not a wizard copy — so what the
 * manager learns here is where it lives afterwards, and a preset's rows can be corrected on the
 * spot.
 */

import {
  ACUITY_PRESETS,
  type AcuityPresetId,
  acuityPresetForUnitType,
  type NurseRole,
  type SetupPreset,
  type SetupPresetResult,
  type SetupStepId,
  SHIFT_PATTERNS,
  type ShiftPatternId,
  today,
  usFederalHolidays,
} from '@shiftnurse/core';
import { type ReactNode, useState } from 'react';
import { useNurses } from '../api.js';
import {
  useAcuityTiers,
  useCoverage,
  useHolidays,
  useRatioRules,
  useShiftTypesList,
} from '../api-config.js';
import { usePayRates } from '../api-cost.js';
import { useApplyPreset } from '../api-setup.js';
import { StateLawSection } from '../components/state-law.js';
import { errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../components/ui.js';
import { ImportDialog } from '../pages/roster/import-dialog.js';
import { NurseFormDialog } from '../pages/roster/nurse-form-dialog.js';
import AcuityPanel from '../pages/settings/acuity.js';
import CancellationOrderPanel from '../pages/settings/cancellation-order.js';
import ConflictsPanel from '../pages/settings/conflicts.js';
import { CoverageTab } from '../pages/settings/coverage-tab.js';
import HolidaysPanel from '../pages/settings/holidays.js';
import LeavePanel from '../pages/settings/leave.js';
import PayPanel from '../pages/settings/pay.js';
import RulesPanel from '../pages/settings/rules.js';
import ShiftTypesPanel from '../pages/settings/shift-types.js';
import SolverPanel from '../pages/settings/solver.js';
import { UnitPoliciesForm } from '../pages/settings/unit.js';
import { useUnit } from '../unit-context.js';
import { useRegisterPreset } from './preset-registry.js';
import { type SetupCounts, STEP_HOME, STEP_TITLES, stepStatus } from './steps.js';

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];

function describeResult(result: SetupPresetResult): string {
  const parts = [];
  if (result.created > 0) parts.push(`${result.created} added`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.unchanged > 0) parts.push(`${result.unchanged} already there`);
  return parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Nothing to change.';
}

/** The preset box: a title, the choices, an apply button and the result line. */
function PresetCard({
  title,
  children,
  applyLabel,
  preset,
  disabled = false,
}: {
  title: string;
  children?: ReactNode;
  applyLabel: string;
  preset: () => SetupPreset;
  disabled?: boolean;
}) {
  const unit = useUnit();
  const apply = useApplyPreset(unit.id);
  const onApply = () => apply.mutate(preset());
  // Offered to the guide's Continue: on a step still empty, Continue applies this preset.
  useRegisterPreset({
    label: () => applyLabel,
    disabled: () => disabled,
    run: () => apply.mutateAsync(preset()),
  });
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-accent/40 bg-surface p-4"
      data-testid="setup-preset"
    >
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {children}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={disabled || apply.isPending}
          onClick={onApply}
        >
          {apply.isPending ? 'Applying…' : applyLabel}
        </button>
        {apply.isSuccess ? (
          <span role="status" className="text-sm text-success">
            {describeResult(apply.data)}
          </span>
        ) : null}
        {apply.isError ? (
          <span role="alert" className="text-sm text-danger">
            {errorMessage(apply.error)}
          </span>
        ) : null}
      </div>
    </section>
  );
}

function StateStep() {
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <StateLawSection offerToContinue />
    </section>
  );
}

function ShiftTypesStep() {
  const [pattern, setPattern] = useState<ShiftPatternId>('12h');
  return (
    <>
      <PresetCard
        title="Start from a common shift pattern"
        applyLabel="Add these shifts"
        preset={() => ({ kind: 'shift-pattern', pattern })}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Shift pattern</legend>
          {(Object.keys(SHIFT_PATTERNS) as ShiftPatternId[]).map((id) => (
            <label key={id} className="flex items-start gap-2 text-sm text-text">
              <input
                type="radio"
                name="shift-pattern"
                checked={pattern === id}
                onChange={() => setPattern(id)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{SHIFT_PATTERNS[id].label}</span>
                <span className="block text-xs text-text-muted">
                  {SHIFT_PATTERNS[id].description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-text-muted">
          Shifts already on the unit with the same code are left as they are. Add on-call or other
          shifts with the editor below.
        </p>
      </PresetCard>
      <ShiftTypesPanel />
    </>
  );
}

function CoverageStep() {
  const unit = useUnit();
  const shiftTypesQuery = useShiftTypesList(unit.id);
  const staffed = (shiftTypesQuery.data ?? []).filter((s) => s.active && !s.isOnCall);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [counts, setCounts] = useState<Record<NurseRole, string>>({ RN: '4', LPN: '0', CNA: '1' });
  const chosen = staffed.filter((s) => !excluded.has(s.id));
  const parsed = Object.fromEntries(ROLES.map((r) => [r, Number(counts[r])])) as Record<
    NurseRole,
    number
  >;
  const valid = ROLES.every((r) => Number.isInteger(parsed[r]) && parsed[r] >= 0);

  return (
    <>
      <PresetCard
        title="Set the same minimum on every shift, every day"
        applyLabel="Set these floors"
        disabled={chosen.length === 0 || !valid}
        preset={() => ({
          kind: 'coverage',
          shiftTypeIds: chosen.map((s) => s.id),
          counts: parsed,
        })}
      >
        {staffed.length === 0 ? (
          <p className="text-sm text-text-muted">
            Floors are set per shift, so add shift types first (go Back), or skip this step.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              {staffed.map((s) => (
                <label key={s.id} className="flex items-center gap-1 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={!excluded.has(s.id)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.delete(s.id);
                      else next.add(s.id);
                      setExcluded(next);
                    }}
                  />
                  {s.name}
                </label>
              ))}
            </div>
            <div className="flex gap-3">
              {ROLES.map((role) => (
                <label key={role} className={LABEL}>
                  {role}s per shift
                  <input
                    type="number"
                    min={0}
                    step={1}
                    className={`${INPUT} w-24`}
                    value={counts[role]}
                    onChange={(e) => setCounts({ ...counts, [role]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              Weekend or weekday differences can be edited in the table below afterwards. Demand
              from census and acuity can raise staffing above these floors, never below.
            </p>
          </>
        )}
      </PresetCard>
      <CoverageTab />
    </>
  );
}

function AcuityStep() {
  const unit = useUnit();
  const [presetId, setPresetId] = useState<AcuityPresetId>(
    acuityPresetForUnitType(unit.unitType) ?? 'med-surg',
  );
  const preset = ACUITY_PRESETS[presetId];
  return (
    <>
      <PresetCard
        title="Start from typical ratios for your kind of unit"
        applyLabel="Add these tiers and ratios"
        preset={() => ({ kind: 'acuity', preset: presetId })}
      >
        <label className={LABEL}>
          Unit type
          <select
            className={`${INPUT} w-60`}
            value={presetId}
            onChange={(e) => setPresetId(e.target.value as AcuityPresetId)}
          >
            {(Object.keys(ACUITY_PRESETS) as AcuityPresetId[]).map((id) => (
              <option key={id} value={id}>
                {ACUITY_PRESETS[id].unitType}
              </option>
            ))}
          </select>
        </label>
        <ul className="text-sm text-text">
          {preset.tiers.map((tier) => {
            const ratio = preset.ratios.find((r) => r.tierLevel === tier.level);
            return (
              <li key={tier.level}>
                {tier.name}: {tier.careHoursPerPatientDay} care hours per patient day
                {ratio ? `, at most ${ratio.maxPatientsPerNurse} patients per RN` : ''}
              </li>
            );
          })}
          <li>Target {preset.hppdTarget} nursing hours per patient day</li>
        </ul>
        <p className="text-xs text-warn">
          These are common starting points, not legal advice. Patient ratios are a hard limit: check
          them against your state's law and your contract.
        </p>
      </PresetCard>
      <AcuityPanel />
    </>
  );
}

function HolidaysStep() {
  const year = Number(today().slice(0, 4));
  const years = [year, year + 1];
  return (
    <>
      <PresetCard
        title="Add the US federal holidays"
        applyLabel={`Add holidays for ${years.join(' and ')}`}
        preset={() => ({ kind: 'holidays', years })}
      >
        <p className="text-sm text-text">
          {usFederalHolidays(year)
            .map((h) => h.name)
            .join(', ')}
          .
        </p>
        <p className="text-xs text-text-muted">
          Holidays are added on the day itself, not the day off in lieu. New Year's Day,
          Independence Day, Thanksgiving and Christmas are marked as major holidays. Dates already
          on the list are skipped.
        </p>
      </PresetCard>
      <HolidaysPanel />
    </>
  );
}

function RulesStep() {
  return (
    <>
      <PresetCard
        title="Use the recommended contract rules"
        applyLabel="Use recommended rules"
        preset={() => ({ kind: 'rules' })}
      >
        <p className="text-sm text-text">
          Rest between shifts, consecutive-shift limits, weekly hours, coverage and charge-nurse
          rules, with the settings below. Change any of them to match your contract and save a new
          version.
        </p>
      </PresetCard>
      <RulesPanel />
    </>
  );
}

function PayStep() {
  const unit = useUnit();
  const [rates, setRates] = useState<Record<NurseRole, string>>({ RN: '', LPN: '', CNA: '' });
  const entered = ROLES.filter((r) => rates[r].trim() !== '');
  const parsed = Object.fromEntries(entered.map((r) => [r, Number(rates[r])]));
  const valid = entered.length > 0 && entered.every((r) => Number(rates[r]) > 0);
  return (
    <>
      <PresetCard
        title="Base hourly rates by role"
        applyLabel="Save base rates"
        disabled={!valid}
        preset={() => ({ kind: 'base-rates', rates: parsed })}
      >
        <div className="flex gap-3">
          {ROLES.map((role) => (
            <label key={role} className={LABEL}>
              {role} $/hour
              <input
                type="number"
                min={0}
                step="0.01"
                className={`${INPUT} w-28`}
                value={rates[role]}
                onChange={(e) => setRates({ ...rates, [role]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-text-muted">
          Effective from {unit.payPeriodAnchor}. Leave a role blank to skip it. Without a rate, that
          role's shifts are counted as unpriced rather than free. Differentials, overtime and
          per-nurse rates are in the editor below.
        </p>
      </PresetCard>
      <PayPanel />
    </>
  );
}

function UnitStep() {
  return <UnitPoliciesForm />;
}

function LeaveStep() {
  return <LeavePanel />;
}

/** Settings › Requests, then the schedule builder: how requests are decided, then how built. */
function RequestsStep() {
  return (
    <div className="flex flex-col gap-4">
      <ConflictsPanel />
      <CancellationOrderPanel />
      <SolverPanel />
    </div>
  );
}

function RosterStep() {
  const unit = useUnit();
  const nursesQuery = useNurses(unit.id);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const active = (nursesQuery.data ?? []).filter((n) => n.active);
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold text-text">Add your staff</h2>
      <p className="text-sm text-text-muted">
        Add nurses one at a time, or import a CSV exported from your HR or timekeeping system.
        Credentials and preferences are edited on the Roster page.
      </p>
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} onClick={() => setAdding(true)}>
          Add a nurse
        </button>
        <button type="button" className={SECONDARY} onClick={() => setImporting(true)}>
          Import CSV
        </button>
      </div>
      <p className="text-sm text-text" role="status">
        {active.length === 0
          ? 'No staff yet.'
          : `${active.length} on the roster: ${active
              .slice(0, 8)
              .map((n) => `${n.firstName} ${n.lastName}`)
              .join(', ')}${active.length > 8 ? '…' : ''}`}
      </p>
      <NurseFormDialog
        open={adding}
        onOpenChange={setAdding}
        unitId={unit.id}
        payPeriodDays={unit.payPeriodDays}
      />
      <ImportDialog open={importing} onOpenChange={setImporting} unitId={unit.id} />
    </section>
  );
}

/** What each step has set up so far, read from the same data its editor shows. */
export function useSetupCounts(unitId: string): SetupCounts {
  const unit = useUnit();
  return {
    hasJurisdiction: unit.jurisdiction !== undefined,
    shiftTypes: (useShiftTypesList(unitId).data ?? []).filter((s) => s.active).length,
    coverage: (useCoverage(unitId).data ?? []).length,
    acuityTiers: (useAcuityTiers(unitId).data ?? []).length,
    ratioRules: (useRatioRules(unitId).data ?? []).filter((r) => r.active).length,
    holidays: (useHolidays(unitId).data ?? []).length,
    roleRates: (usePayRates(unitId).data ?? []).filter((r) => r.nurseId === null).length,
    nurses: (useNurses(unitId).data ?? []).filter((n) => n.active).length,
  };
}

/** What a unit must have before Generate can build anything. */
const NEEDED_TO_SCHEDULE: readonly (keyof typeof STEP_HOME)[] = [
  'shift-types',
  'coverage',
  'roster',
];

/** How the summary words a done step: the rules and reviewed defaults were never "set up". */
const DONE_WORD: Partial<Record<keyof typeof STEP_HOME, string>> = {
  rules: 'in force',
  unit: 'reviewed',
  leave: 'reviewed',
  requests: 'reviewed',
};

function FinishStep({
  skipped,
  onGoTo,
}: {
  skipped: readonly SetupStepId[];
  onGoTo: (step: SetupStepId) => void;
}) {
  const unit = useUnit();
  const counts = useSetupCounts(unit.id);
  const steps = Object.keys(STEP_HOME) as (keyof typeof STEP_HOME)[];
  const missing = NEEDED_TO_SCHEDULE.filter((s) => stepStatus(s, counts, skipped) !== 'done');
  return (
    <section className="rounded-md border border-border bg-surface p-4" data-testid="setup-summary">
      <h2 className="mb-1 text-sm font-semibold text-text">
        {missing.length === 0
          ? `${unit.name} is ready to schedule`
          : `${unit.name} needs ${missing.length} more thing${missing.length === 1 ? '' : 's'} before you can schedule`}
      </h2>
      <p className="mb-3 text-xs text-text-muted">
        {missing.length === 0
          ? 'Anything left for later can be set up any time; the Dashboard lists it.'
          : `Still needed: ${missing.map((s) => STEP_TITLES[s].toLowerCase()).join(', ')}. You can open ShiftNurse now and finish them later — the Dashboard will list them.`}
      </p>
      <ul className="flex flex-col gap-2 text-sm">
        {steps.map((step) => {
          const status = stepStatus(step, counts, skipped);
          return (
            <li key={step} className="flex items-baseline gap-2">
              <span aria-hidden className={status === 'done' ? 'text-success' : 'text-warn'}>
                {status === 'done' ? '✓' : '○'}
              </span>
              <span className="font-medium text-text">{STEP_TITLES[step]}</span>
              <span className="text-text-muted">
                {status === 'done'
                  ? (DONE_WORD[step] ?? 'set up')
                  : `${status === 'skipped' ? 'left for later' : 'not set up yet'} — later in ${STEP_HOME[step]}`}
              </span>
              {status !== 'done' ? (
                <button
                  type="button"
                  className="text-xs text-accent underline underline-offset-2"
                  onClick={() => onGoTo(step)}
                >
                  Set it up now
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-text-muted">
        To schedule, the unit needs shift types, staffing floors and a roster. Next, create a
        scheduling period on the Schedule page and press Generate.
      </p>
    </section>
  );
}

export function StepBody({
  step,
  skipped,
  onGoTo,
}: {
  step: SetupStepId;
  skipped: readonly SetupStepId[];
  onGoTo: (step: SetupStepId) => void;
}) {
  switch (step) {
    case 'state':
      return <StateStep />;
    case 'shift-types':
      return <ShiftTypesStep />;
    case 'coverage':
      return <CoverageStep />;
    case 'acuity':
      return <AcuityStep />;
    case 'holidays':
      return <HolidaysStep />;
    case 'rules':
      return <RulesStep />;
    case 'pay':
      return <PayStep />;
    case 'unit':
      return <UnitStep />;
    case 'leave':
      return <LeaveStep />;
    case 'requests':
      return <RequestsStep />;
    case 'roster':
      return <RosterStep />;
    case 'finish':
      return <FinishStep skipped={skipped} onGoTo={onGoTo} />;
  }
}
