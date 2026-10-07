/**
 * The call-back minimum: the fewest hours a call-back pays, from the contract. It prices the
 * "Called back" events recorded on Today, in the cost report's day-of pay section. A unit that
 * has never set it pays the hours worked.
 */

import type { Id } from '@shiftnurse/core';
import { useState } from 'react';
import type { PaySettings } from '../../../../../shared/api.js';
import { usePaySettings, useSavePaySettings } from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { errorMessage, INPUT, PRIMARY } from '../../../components/ui.js';
import { useUnsavedChanges } from '../../../components/unsaved-changes.js';

export function CallBackSection({ unitId }: { unitId: Id }) {
  const query = usePaySettings(unitId);
  if (query.isPending) return <AsyncState status="loading" label="Loading pay settings" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load pay settings" error={query.error} />;
  }
  return (
    <CallBackForm unitId={unitId} saved={query.data.callBackMinimumHours} settings={query.data} />
  );
}

function CallBackForm({
  unitId,
  saved,
  settings,
}: {
  unitId: Id;
  saved: number;
  settings: PaySettings;
}) {
  const save = useSavePaySettings(unitId);
  const [value, setValue] = useState(String(saved));
  const hours = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(hours) && hours >= 0 && hours <= 24;
  const dirty = valid && hours !== saved;
  useUnsavedChanges('Call-back minimum hours', value !== String(saved));
  const error = errorMessage(save.error);
  const problem = valid ? undefined : 'Enter a number of hours from 0 to 24.';

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Call-back</h2>
      <form
        className="flex max-w-md flex-col gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) save.mutate({ ...settings, callBackMinimumHours: hours });
        }}
      >
        <Field
          id="call-back-minimum"
          label="Call-back minimum hours"
          hint="The fewest hours a call-back pays. 0 pays the hours worked."
          tip="Many contracts guarantee a call-back a minimum, such as 2 or 4 hours, even if the nurse is sent home sooner. Enter the figure from yours. The call-back differential, if you have one, is set above and applies to these hours."
          error={problem ?? error}
        >
          <input
            id="call-back-minimum"
            type="number"
            min={0}
            max={24}
            step={0.25}
            className={`${INPUT} w-28`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={describedBy('call-back-minimum', {
              hint: true,
              error: (problem ?? error) !== undefined,
            })}
          />
        </Field>
        <div className="flex justify-end">
          <button type="submit" className={PRIMARY} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}
