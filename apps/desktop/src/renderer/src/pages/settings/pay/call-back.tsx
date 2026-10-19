/**
 * The call-back minimum: the fewest hours a call-back pays, from the contract. It prices the
 * "Called back" events recorded on Today, in the cost report's day-of pay section. A unit that
 * has never set it pays the hours worked.
 *
 * Beside it, the reporting-pay notice (D13): a low-census cancellation told with less notice
 * than this before the shift, or after it started, still books reporting-time pay.
 */

import type { Id } from '@shiftnurse/core';
import type { PaySettings } from '../../../../../shared/api.js';
import { usePaySettings, useSavePaySettings } from '../../../api-cost.js';
import { AsyncState } from '../../../components/async-state.js';
import { EditorShell } from '../../../components/editor-shell.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT } from '../../../components/ui.js';
import { numberFieldProblem, parseNumberField, useFieldDraft } from '../../../field-values.js';

export function CallBackSection({ unitId }: { unitId: Id }) {
  const query = usePaySettings(unitId);
  if (query.isPending) return <AsyncState status="loading" label="Loading pay settings" />;
  if (query.isError) {
    return <AsyncState status="error" label="Could not load pay settings" error={query.error} />;
  }
  return <CallBackForm unitId={unitId} settings={query.data} />;
}

function CallBackForm({ unitId, settings }: { unitId: Id; settings: PaySettings }) {
  const save = useSavePaySettings(unitId);
  const savedMinimum = settings.callBackMinimumHours;
  const savedNotice = settings.reportingPayNoticeHours;
  const minimum = useFieldDraft(String(savedMinimum));
  const notice = useFieldDraft(String(savedNotice));
  const minimumProblem = numberFieldProblem(minimum.text, { min: 0, max: 24 });
  const noticeProblem = numberFieldProblem(notice.text, { min: 0, max: 24 });
  // A field with a problem is an edit too, or Discard would not offer to take it back; `2.0`
  // against a saved 2 is no edit at all.
  const minimumDirty =
    minimumProblem !== undefined || parseNumberField(minimum.text) !== savedMinimum;
  const noticeDirty = noticeProblem !== undefined || parseNumberField(notice.text) !== savedNotice;
  const dirty = minimumDirty || noticeDirty;
  const canSave = minimumProblem === undefined && noticeProblem === undefined;

  function submit() {
    const callBackMinimumHours = parseNumberField(minimum.text);
    const reportingPayNoticeHours = parseNumberField(notice.text);
    if (!canSave || callBackMinimumHours === undefined || reportingPayNoticeHours === undefined) {
      return;
    }
    save.mutate(
      { ...settings, callBackMinimumHours, reportingPayNoticeHours },
      {
        // Follow the saved row again, so a figure typed as 4.0 settles to what the server holds.
        onSuccess: () => {
          minimum.reset(String(callBackMinimumHours));
          notice.reset(String(reportingPayNoticeHours));
        },
      },
    );
  }
  function discard() {
    minimum.reset(String(savedMinimum));
    notice.reset(String(savedNotice));
    save.reset();
  }

  return (
    <section className="mt-8">
      <EditorShell
        label="Call-back minimum hours"
        dirty={dirty}
        saving={save.isPending}
        error={save.error}
        canSave={canSave}
        formId="call-back-form"
        onSave={submit}
        onDiscard={discard}
      >
        <h2 className="mb-1 text-sm font-semibold text-text">Call-back</h2>
        <form
          id="call-back-form"
          className="flex max-w-md flex-col gap-2 rounded-md border border-border bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            id="call-back-minimum"
            label="Call-back minimum hours"
            hint="The fewest hours a call-back pays. 0 pays the hours worked."
            tip="Many contracts guarantee a call-back a minimum, such as 2 or 4 hours, even if the nurse is sent home sooner. Enter the figure from yours. The call-back differential, if you have one, is set above and applies to these hours."
            error={minimumProblem}
          >
            <input
              id="call-back-minimum"
              type="number"
              min={0}
              max={24}
              step={0.25}
              className={`${INPUT} w-28`}
              value={minimum.text}
              onChange={(e) => minimum.setText(e.target.value)}
              {...minimum.bind}
              aria-describedby={describedBy('call-back-minimum', {
                hint: true,
                error: minimumProblem !== undefined,
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
              value={notice.text}
              onChange={(e) => notice.setText(e.target.value)}
              {...notice.bind}
              aria-describedby={describedBy('reporting-pay-notice', {
                hint: true,
                error: noticeProblem !== undefined,
              })}
            />
          </Field>
          {save.isSuccess && !dirty ? (
            <p role="status" className="text-sm text-success">
              Saved.
            </p>
          ) : null}
        </form>
      </EditorShell>
    </section>
  );
}
