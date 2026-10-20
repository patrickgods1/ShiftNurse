/**
 * The call-back minimum: the fewest hours a call-back pays, from the contract. It prices the
 * "Called back" events recorded on Today, in the cost report's day-of pay section. A unit that
 * has never set it pays the hours worked.
 *
 * Beside it, the reporting-pay notice (D13): a low-census cancellation told with less notice
 * than this before the shift, or after it started, still books reporting-time pay.
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
  return <CallBackForm unitId={unitId} settings={query.data} />;
}

const HOURS_PROBLEM = 'Enter a number of hours from 0 to 24.';

/** A 0–24 hour figure typed into a field: its number, and whether it may be saved. */
function dayHours(value: string): { hours: number; valid: boolean } {
  const hours = Number(value);
  return {
    hours,
    valid: value.trim() !== '' && Number.isFinite(hours) && hours >= 0 && hours <= 24,
  };
}

function CallBackForm({ unitId, settings }: { unitId: Id; settings: PaySettings }) {
  const save = useSavePaySettings(unitId);
  const savedMinimum = settings.callBackMinimumHours;
  const savedNotice = settings.reportingPayNoticeHours;
  const [value, setValue] = useState(String(savedMinimum));
  const [noticeValue, setNoticeValue] = useState(String(savedNotice));
  const minimum = dayHours(value);
  const notice = dayHours(noticeValue);
  const valid = minimum.valid && notice.valid;
  const dirty = valid && (minimum.hours !== savedMinimum || notice.hours !== savedNotice);
  useUnsavedChanges('Call-back minimum hours', value !== String(savedMinimum));
  useUnsavedChanges('Reporting-pay notice', noticeValue !== String(savedNotice));
  const error = errorMessage(save.error);
  const minimumProblem = minimum.valid ? undefined : HOURS_PROBLEM;
  const noticeProblem = notice.valid ? undefined : HOURS_PROBLEM;

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-sm font-semibold text-text">Call-back</h2>
      <form
        className="flex max-w-md flex-col gap-2 rounded-md border border-border bg-surface p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            save.mutate({
              ...settings,
              callBackMinimumHours: minimum.hours,
              reportingPayNoticeHours: notice.hours,
            });
          }
        }}
      >
        <Field
          id="call-back-minimum"
          label="Call-back minimum hours"
          hint="The fewest hours a call-back pays. 0 pays the hours worked."
          tip="Many contracts guarantee a call-back a minimum, such as 2 or 4 hours, even if the nurse is sent home sooner. Enter the figure from yours. The call-back differential, if you have one, is set above and applies to these hours."
          error={minimumProblem ?? error}
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
              error: (minimumProblem ?? error) !== undefined,
            })}
          />
        </Field>
        <Field
          id="reporting-pay-notice"
          label="Reporting-pay notice (hours)"
          hint="Sending someone home with less notice than this before the shift starts still pays reporting time. 0 pays it only once the shift has started."
          error={noticeProblem}
        >
          <input
            id="reporting-pay-notice"
            type="number"
            min={0}
            max={24}
            step={0.25}
            className={`${INPUT} w-28`}
            value={noticeValue}
            onChange={(e) => setNoticeValue(e.target.value)}
            aria-describedby={describedBy('reporting-pay-notice', {
              hint: true,
              error: noticeProblem !== undefined,
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
