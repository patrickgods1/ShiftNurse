/**
 * "State law": pick a state and apply its staffing and overtime settings to the unit. Shared by
 * Settings › Unit and the assisted guide's ratios step so both read the same summary and ask
 * the same confirmation.
 *
 * The summary is shown before Apply because the preset is a starting point: it says what the
 * law asks and, as plainly, what it leaves to the hospital. Applying only ever tightens, so the
 * confirmation says that rather than inviting a manager to fear it overwrites their contract.
 */

import {
  JURISDICTION_PRESETS,
  type JurisdictionChoices,
  type JurisdictionId,
  type JurisdictionPreset,
  type SetupPresetResult,
  type Unit,
} from '@shiftnurse/core';
import { useState } from 'react';
import { useApplyJurisdiction } from '../api-setup.js';
import { useUnit } from '../unit-context.js';
import { useConfirm } from './confirm.js';
import { CheckField, describedBy, Field } from './field-help.js';
import { errorMessage, INPUT, SECONDARY } from './ui.js';

const IDS = Object.keys(JURISDICTION_PRESETS) as JurisdictionId[];

function describeResult(result: SetupPresetResult): string {
  const parts = [];
  if (result.created > 0) parts.push(`${result.created} added`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.unchanged > 0) parts.push(`${result.unchanged} already there`);
  return parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Nothing to change.';
}

/**
 * What applying will do to the leave policy. A preset's policy goes in whole and only into a unit
 * with none (`planJurisdiction`), so the line says "leaves" when the manager already set one.
 */
function leavePolicyLine(preset: JurisdictionPreset, unit: Unit): string {
  const policy = preset.leavePolicy;
  if (policy === undefined || unit.leavePolicy !== undefined) {
    return 'Leaves your leave policy as it is';
  }
  const rules = policy.accrual.length;
  return `Sets the leave policy: ${policy.fmla.regime === 'title5' ? 'Title 5' : 'Title I'} FMLA, ${
    policy.leaveYearStart === 'first_full_pay_period' ? 'federal' : 'calendar'
  } leave year, ${rules} accrual ${rules === 1 ? 'rule' : 'rules'}`;
}

export function StateLawSection() {
  const unit = useUnit();
  const apply = useApplyJurisdiction(unit.id);
  const confirm = useConfirm();
  const [chosen, setChosen] = useState<JurisdictionId | ''>(unit.jurisdiction ?? '');
  const preset = chosen === '' ? undefined : JURISDICTION_PRESETS[chosen];
  // Answers belong to the chosen state's questions, so changing state starts them over; the
  // applied state's stored answers come back, or Apply would quietly answer them no again.
  const storedChoices = (id: JurisdictionId | '') =>
    id !== '' && id === unit.jurisdiction ? (unit.jurisdictionChoices ?? {}) : {};
  const [choices, setChoices] = useState<JurisdictionChoices>(() => storedChoices(chosen));

  const onApply = async () => {
    if (chosen === '' || !preset) return;
    const ok = await confirm({
      title:
        chosen === 'other' ? 'Record that no preset applies?' : `Apply ${preset.label}'s settings?`,
      description:
        'This adds the ratio ceilings, overtime rules and rule switches in the summary, and never loosens a setting you have.',
      confirmLabel: 'Apply',
      danger: false,
    });
    if (ok) apply.mutate({ jurisdiction: chosen, choices });
  };

  return (
    <fieldset
      className="flex max-w-xl flex-col gap-3 border-t border-border pt-3"
      data-testid="state-law"
    >
      <legend className="pr-2 text-sm font-semibold text-text">State or federal law</legend>
      <Field
        id="unit-jurisdiction"
        label="State or federal law"
        hint="Fills in what your state's or federal law asks: ratio ceilings, overtime and the ban on mandatory overtime. It only tightens settings."
        tip="Check the summary against your contract — most contracts go further than the law."
      >
        <select
          id="unit-jurisdiction"
          className={`${INPUT} w-60`}
          value={chosen}
          aria-describedby={describedBy('unit-jurisdiction', { hint: true })}
          onChange={(e) => {
            const next = e.target.value as JurisdictionId | '';
            setChosen(next);
            setChoices(storedChoices(next));
            apply.reset();
          }}
        >
          <option value="">Choose a state or federal law…</option>
          {IDS.map((id) => (
            <option key={id} value={id}>
              {JURISDICTION_PRESETS[id].label}
            </option>
          ))}
        </select>
      </Field>
      {unit.jurisdiction ? (
        <p className="text-xs text-text-muted">
          Last applied: {JURISDICTION_PRESETS[unit.jurisdiction].label}.
        </p>
      ) : null}
      {preset ? (
        <p className="text-sm text-text" data-testid="state-law-summary">
          {preset.summary}
        </p>
      ) : null}
      {preset?.source ? (
        <div className="text-sm text-text" data-testid="state-law-source">
          <p>Contract values: {preset.source.contract}</p>
          {preset.source.note ? (
            <p className="text-xs text-text-muted">{preset.source.note}</p>
          ) : null}
        </div>
      ) : null}
      {preset ? (
        <p className="text-sm text-text" data-testid="state-law-leave">
          {leavePolicyLine(preset, unit)}.
        </p>
      ) : null}
      {preset?.options?.map((option) => {
        const fieldId = `state-law-option-${option.id}`;
        return (
          <CheckField key={option.id} id={fieldId} label={option.label} hint={option.hint}>
            <input
              id={fieldId}
              type="checkbox"
              data-testid={fieldId}
              checked={choices[option.id] === true}
              aria-describedby={describedBy(fieldId, { hint: true })}
              onChange={(e) => {
                setChoices({ ...choices, [option.id]: e.target.checked });
                apply.reset();
              }}
            />
          </CheckField>
        );
      })}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={SECONDARY}
          disabled={chosen === '' || apply.isPending}
          onClick={() => void onApply()}
        >
          {apply.isPending ? 'Applying…' : 'Apply'}
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
      <p className="text-xs text-warn">Presets are a starting point, not legal advice.</p>
    </fieldset>
  );
}
