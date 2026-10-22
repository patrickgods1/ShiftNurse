/**
 * Premium stacking: whether a shift's multiplier differentials and its overtime compound (the
 * FLSA regular rate) or each add a percentage of base pay (UC–CNA Art. 14 § M, Title 38). Without
 * the choice, an additive contract would be priced as compounding and every premium shift would
 * come out high. Beside it, the other choices about which rate or hours a premium is paid on:
 * the spring-forward night as scheduled, and missed breaks at the regular rate (California).
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
  const [attribution, setAttribution] = useState(saved.overtimeWindowAttribution);
  const [springAsScheduled, setSpringAsScheduled] = useState(saved.paySpringForwardAsScheduled);
  const [breakRate, setBreakRate] = useState(saved.breakPremiumRate);
  const dirty =
    value !== saved.premiumStacking ||
    coversOvertime !== saved.holidayPayCoversOvertime ||
    attribution !== saved.overtimeWindowAttribution ||
    springAsScheduled !== saved.paySpringForwardAsScheduled ||
    breakRate !== saved.breakPremiumRate;

  function submit() {
    // Spread the saved row: the save replaces the unit's whole settings row, so a field this form
    // does not show must travel unchanged.
    save.mutate({
      ...saved,
      premiumStacking: value,
      holidayPayCoversOvertime: coversOvertime,
      overtimeWindowAttribution: attribution,
      paySpringForwardAsScheduled: springAsScheduled,
      breakPremiumRate: breakRate,
    });
  }
  function discard() {
    setValue(saved.premiumStacking);
    setCoversOvertime(saved.holidayPayCoversOvertime);
    setAttribution(saved.overtimeWindowAttribution);
    setSpringAsScheduled(saved.paySpringForwardAsScheduled);
    setBreakRate(saved.breakPremiumRate);
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
                Additive (UC–CNA Art. 14 § M, Title 38): every premium and overtime is a percentage
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
          <Field
            id="overtime-window-attribution"
            label="Shifts that cross into a new work week or pay period"
            hint="Matters for weekly and 80-hour overtime when a night runs past midnight at the end of the week."
          >
            <select
              id="overtime-window-attribution"
              className={INPUT}
              value={attribution}
              aria-describedby={describedBy('overtime-window-attribution', { hint: true })}
              onChange={(e) =>
                setAttribution(e.target.value as PaySettings['overtimeWindowAttribution'])
              }
            >
              <option value="clock">
                Count each hour in the week it is worked (29 CFR 778.104)
              </option>
              <option value="start">
                Count the whole shift in the week it starts (some contracts)
              </option>
            </select>
          </Field>
          <CheckField
            id="pay-spring-forward-as-scheduled"
            label="Pay the spring-forward night as the hours scheduled"
            hint="The night the clocks go forward is 11 hours worked. On, its straight pay is the 12 scheduled; overtime still counts the 11."
            tip="Federal law pays the hours actually worked, so leave it off unless the contract pays that night as scheduled. Overtime, the overtime rate and the hour limits never count the hour that was not worked."
          >
            <input
              id="pay-spring-forward-as-scheduled"
              type="checkbox"
              checked={springAsScheduled}
              aria-describedby={describedBy('pay-spring-forward-as-scheduled', { hint: true })}
              onChange={(e) => setSpringAsScheduled(e.target.checked)}
            />
          </CheckField>
          <Field
            id="break-premium-rate"
            label="Missed meal and rest breaks are paid at"
            hint="The hour of pay owed for a missed break, recorded on Today."
            tip="California owes it at the regular rate: the week's straight pay, differentials included, over its hours (Lab. Code § 226.7; Ferra v. Loews Hollywood Hotel, 2021). A week with no shifts on this schedule pays the base rate."
          >
            <select
              id="break-premium-rate"
              className={INPUT}
              value={breakRate}
              aria-describedby={describedBy('break-premium-rate', { hint: true })}
              onChange={(e) => setBreakRate(e.target.value as PaySettings['breakPremiumRate'])}
            >
              <option value="base">The base rate</option>
              <option value="regular">
                The regular rate, with differentials in it (California)
              </option>
            </select>
          </Field>
        </form>
      </EditorShell>
    </section>
  );
}
