/**
 * Premium stacking: whether a shift's multiplier differentials and its overtime compound (the
 * FLSA regular rate) or each add a percentage of base pay (UC–CNA Art. 14 §N, Title 38). Without
 * the choice, an additive contract would be priced as compounding and every premium shift would
 * come out high.
 */

import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import type { PaySettings } from '../../../../../shared/api.js';
import { usePaySettings, useSavePaySettings } from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { EditorShell } from '../../../components/editor-shell.js';
import { CheckField, describedBy, Field } from '../../../components/field-help.js';
import { INPUT } from '../../../components/ui.js';

export function StackingSection({ unitId }: { unitId: Id }) {
  const query = usePaySettings(unitId);
  if (query.isPending) return <AsyncState status="loading" label="Loading pay settings" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load pay settings" error={query.error} />;
  }
  return <StackingForm unitId={unitId} saved={query.data} />;
}

function StackingForm({ unitId, saved }: { unitId: Id; saved: PaySettings }) {
  const save = useSavePaySettings(unitId);
  const [value, setValue] = useState<PaySettings['premiumStacking']>(saved.premiumStacking);
  const [coversOvertime, setCoversOvertime] = useState(saved.holidayPayCoversOvertime);
  const dirty =
    value !== saved.premiumStacking || coversOvertime !== saved.holidayPayCoversOvertime;

  function submit() {
    // Spread the saved row: the save replaces the unit's whole settings row, so a field this form
    // does not show must travel unchanged.
    save.mutate({ ...saved, premiumStacking: value, holidayPayCoversOvertime: coversOvertime });
  }
  function discard() {
    setValue(saved.premiumStacking);
    setCoversOvertime(saved.holidayPayCoversOvertime);
    save.reset();
  }

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Premium stacking</h2>
      <EditorShell
        label="Premium stacking"
        dirty={dirty}
        saving={save.isPending}
        error={save.error}
        formId="stacking-form"
        onSave={submit}
        onDiscard={discard}
      >
        <form
          id="stacking-form"
          className="flex max-w-xl flex-col gap-2 rounded-md border border-border bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field id="premium-stacking" label="Premium stacking">
            <select
              id="premium-stacking"
              className={INPUT}
              value={value}
              onChange={(e) => setValue(e.target.value as PaySettings['premiumStacking'])}
            >
              <option value="compound">
                Compound (FLSA regular rate): multipliers apply to the rate with differentials in
                it, and overtime to that rate
              </option>
              <option value="additive">
                Additive (UC–CNA Art. 14 §N, Title 38): every premium and overtime is a percentage
                of base pay, added together
              </option>
            </select>
          </Field>
          <CheckField
            id="holiday-pay-covers-overtime"
            label="Holiday pay covers overtime worked on the holiday (38 U.S.C. § 7453(g))"
            hint="Leave it off under the FLSA regular rate: overtime on a holiday earns both premiums."
          >
            <input
              id="holiday-pay-covers-overtime"
              type="checkbox"
              checked={coversOvertime}
              aria-describedby={describedBy('holiday-pay-covers-overtime', { hint: true })}
              onChange={(e) => setCoversOvertime(e.target.checked)}
            />
          </CheckField>
        </form>
      </EditorShell>
    </section>
  );
}
