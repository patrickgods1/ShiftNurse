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
  type JurisdictionId,
  type SetupPresetResult,
} from '@shiftnurse/core';
import { useState } from 'react';
import { useApplyJurisdiction } from '../api-setup.js';
import { useUnit } from '../unit-context.js';
import { useConfirm } from './confirm.js';
import { describedBy, Field } from './field-help.js';
import { errorMessage, INPUT, SECONDARY } from './ui.js';

const IDS = Object.keys(JURISDICTION_PRESETS) as JurisdictionId[];

function describeResult(result: SetupPresetResult): string {
  const parts = [];
  if (result.created > 0) parts.push(`${result.created} added`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.unchanged > 0) parts.push(`${result.unchanged} already there`);
  return parts.length > 0 ? `Done: ${parts.join(', ')}.` : 'Nothing to change.';
}

export function StateLawSection() {
  const unit = useUnit();
  const apply = useApplyJurisdiction(unit.id);
  const confirm = useConfirm();
  const [chosen, setChosen] = useState<JurisdictionId | ''>(unit.jurisdiction ?? '');
  const preset = chosen === '' ? undefined : JURISDICTION_PRESETS[chosen];

  const onApply = async () => {
    if (chosen === '' || !preset) return;
    const ok = await confirm({
      title:
        chosen === 'other'
          ? 'Record that no state preset applies?'
          : `Apply ${preset.label}'s settings?`,
      description:
        'This adds the ratio ceilings, overtime rules and rule switches in the summary, and never loosens a setting you have.',
      confirmLabel: 'Apply',
      danger: false,
    });
    if (ok) apply.mutate(chosen);
  };

  return (
    <fieldset
      className="flex max-w-xl flex-col gap-3 border-t border-border pt-3"
      data-testid="state-law"
    >
      <legend className="pr-2 text-sm font-semibold text-text">State law</legend>
      <Field
        id="unit-jurisdiction"
        label="State"
        hint="Fills in what your state's law asks: ratio ceilings, overtime and the ban on mandatory overtime. It only tightens settings."
        tip="Check the summary against your contract — most contracts go further than the law."
      >
        <select
          id="unit-jurisdiction"
          className={`${INPUT} w-60`}
          value={chosen}
          aria-describedby={describedBy('unit-jurisdiction', { hint: true })}
          onChange={(e) => {
            setChosen(e.target.value as JurisdictionId | '');
            apply.reset();
          }}
        >
          <option value="">Choose a state…</option>
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
      <p className="text-xs text-warn">State presets are a starting point, not legal advice.</p>
    </fieldset>
  );
}
