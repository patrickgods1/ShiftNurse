/**
 * Settings › Unit: the unit's name and type, the way back into the setup guide, and Start
 * over. The pay-period calendar is shown but not editable: contracted hours are counted per
 * pay period, and moving the calendar would re-judge every period already counted in it.
 *
 * Start over is how an evaluator leaves the demo for real data. It deletes everything, so it
 * confirms by naming what is kept: a `pre-reset` backup that Settings › Backups can restore.
 */

import { ACUITY_PRESETS, type RatioStaffing } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useResumeSetup, useStartOver, useUpdateUnit } from '../../api-setup.js';
import { useConfirm } from '../../components/confirm.js';
import { EditorShell } from '../../components/editor-shell.js';
import { CheckField, describedBy, Field, InfoTip } from '../../components/field-help.js';
import { StateLawSection } from '../../components/state-law.js';
import { DANGER, errorMessage, INPUT, SECONDARY } from '../../components/ui.js';
import { useUnit } from '../../unit-context.js';

/** The reading before the settings existed: the charge nurse counts, and nobody takes breaks. */
const DEFAULT_RATIO_STAFFING: RatioStaffing = {
  chargeNurseTakesPatients: true,
  breakMinutesPerNurse: 0,
  chargeCoversBreaks: false,
};

const UNIT_TYPES = Object.values(ACUITY_PRESETS).map((p) => p.unitType);

export default function UnitPanel() {
  const unit = useUnit();
  const update = useUpdateUnit();
  const resume = useResumeSetup();
  const startOver = useStartOver();
  const confirm = useConfirm();
  const [name, setName] = useState(unit.name);
  const [unitType, setUnitType] = useState(unit.unitType);
  const saved = unit.ratioStaffing ?? DEFAULT_RATIO_STAFFING;
  const [takesPatients, setTakesPatients] = useState(saved.chargeNurseTakesPatients);
  const [breakMinutes, setBreakMinutes] = useState(String(saved.breakMinutesPerNurse));
  const [coversBreaks, setCoversBreaks] = useState(saved.chargeCoversBreaks);
  const savedLead = unit.postingLeadDays === undefined ? '' : String(unit.postingLeadDays);
  const [leadDays, setLeadDays] = useState(savedLead);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the saved unit changes.
  useEffect(() => {
    setName(unit.name);
    setUnitType(unit.unitType);
    setTakesPatients(saved.chargeNurseTakesPatients);
    setBreakMinutes(String(saved.breakMinutesPerNurse));
    setCoversBreaks(saved.chargeCoversBreaks);
    setLeadDays(savedLead);
  }, [unit.id, unit.name, unit.unitType, unit.ratioStaffing, unit.postingLeadDays]);

  // A charge nurse who takes patients has none to spare for breaks, so the box only counts
  // while they are kept free of them.
  const minutes = Number(breakMinutes);
  const minutesValid =
    breakMinutes.trim() !== '' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 240;
  // Blank clears the rule, so it is the one empty value that is valid.
  const lead = Number(leadDays);
  const leadValid = leadDays.trim() === '' || (Number.isInteger(lead) && lead >= 0 && lead <= 90);
  const staffing: RatioStaffing = {
    chargeNurseTakesPatients: takesPatients,
    breakMinutesPerNurse: minutesValid ? minutes : saved.breakMinutesPerNurse,
    chargeCoversBreaks: !takesPatients && coversBreaks,
  };
  const dirty =
    name !== unit.name ||
    unitType !== unit.unitType ||
    staffing.chargeNurseTakesPatients !== saved.chargeNurseTakesPatients ||
    breakMinutes !== String(saved.breakMinutesPerNurse) ||
    staffing.chargeCoversBreaks !== saved.chargeCoversBreaks ||
    leadDays !== savedLead;

  const submit = () => {
    update.mutate({
      id: unit.id,
      patch: {
        name: name.trim(),
        unitType: unitType.trim(),
        ratioStaffing: staffing,
        postingLeadDays: leadDays.trim() === '' ? null : lead,
      },
    });
  };
  const discard = () => {
    setName(unit.name);
    setUnitType(unit.unitType);
    setTakesPatients(saved.chargeNurseTakesPatients);
    setBreakMinutes(String(saved.breakMinutesPerNurse));
    setCoversBreaks(saved.chargeCoversBreaks);
    setLeadDays(savedLead);
    update.reset();
  };

  const onStartOver = async () => {
    const ok = await confirm({
      title: 'Start over with an empty database?',
      description:
        'Every unit, nurse, schedule and setting is deleted and ShiftNurse restarts at the welcome screen. A "Before start over" backup is saved first; restore it from Settings › Backups to undo this.',
      confirmLabel: 'Delete everything and restart',
    });
    if (ok) startOver.mutate();
  };

  return (
    <div className="flex flex-col gap-4" data-testid="unit-panel">
      <EditorShell
        label="Unit"
        dirty={dirty}
        saving={update.isPending}
        error={update.error}
        canSave={name.trim() !== '' && minutesValid && leadValid}
        formId="unit-form"
        onSave={submit}
        onDiscard={discard}
      >
        <section className="rounded-md border border-border bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-text">Unit</h2>
          <form
            id="unit-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex flex-col gap-3"
          >
            <div className="grid max-w-xl grid-cols-2 gap-3">
              <Field id="unit-name" label="Name" hint="Shown in the app and on printed schedules.">
                <input
                  id="unit-name"
                  className={INPUT}
                  value={name}
                  aria-describedby={describedBy('unit-name', { hint: true })}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                id="unit-type"
                label="Type"
                hint="Used to suggest typical patient ratios in the setup guide. Any wording is fine."
              >
                <input
                  id="unit-type"
                  className={INPUT}
                  list="unit-type-suggestions"
                  value={unitType}
                  aria-describedby={describedBy('unit-type', { hint: true })}
                  onChange={(e) => setUnitType(e.target.value)}
                />
                <datalist id="unit-type-suggestions">
                  {UNIT_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
            </div>
            <p className="flex items-center gap-1 text-xs text-text-muted">
              Pay periods are {unit.payPeriodDays} days long, counted from {unit.payPeriodAnchor}.
              <InfoTip label="the pay period">
                Set when the unit was created and fixed after that. Contracted hours and pay-period
                overtime are counted per pay period, so moving the calendar would re-judge every
                period already counted in it.
              </InfoTip>
            </p>
            <Field
              id="unit-posting-lead"
              className="max-w-xl"
              label="Post schedules this many days ahead"
              hint="Many contracts require the schedule to be posted 2–4 weeks before it starts. Leave blank for no check."
              tip="Publishing a schedule later than this many days before its first day raises a late-posting alert in the publish preview, and the Dashboard shows the date the next schedule is due."
              error={
                leadValid ? undefined : 'Enter a whole number of days from 0 to 90, or leave blank.'
              }
            >
              <input
                id="unit-posting-lead"
                type="number"
                min={0}
                max={90}
                step={1}
                className={`${INPUT} w-28`}
                value={leadDays}
                aria-describedby={describedBy('unit-posting-lead', {
                  hint: true,
                  error: !leadValid,
                })}
                onChange={(e) => setLeadDays(e.target.value)}
              />
            </Field>
            <fieldset className="flex max-w-xl flex-col gap-3 border-t border-border pt-3">
              <legend className="pr-2 text-sm font-semibold text-text">
                Keeping ratios at all times
              </legend>
              <CheckField
                id="unit-charge-takes-patients"
                label="The charge nurse takes patients"
                hint="Untick where the charge nurse is kept free of patients — California and Oregon count a charge nurse toward the ratio only while caring for patients. Each standalone shift then needs one more RN."
                tip="With the box ticked the charge nurse is one of the nurses the ratio counts. Unticked, the ratio is met by the other nurses and the charge RN is added on top."
              >
                <input
                  id="unit-charge-takes-patients"
                  type="checkbox"
                  checked={takesPatients}
                  aria-describedby={describedBy('unit-charge-takes-patients', { hint: true })}
                  onChange={(e) => setTakesPatients(e.target.checked)}
                />
              </CheckField>
              <Field
                id="unit-break-minutes"
                label="Break minutes per nurse per shift"
                hint="Minutes each bedside nurse is off the floor for meals and rest breaks. The ratio must still hold while they are away, so relief nurses are added."
                tip="For example 60 for a 30-minute meal and two 15-minute rests. Leave at 0 where breaks are covered by the nurses already counted. No breaks fall in a shift's first or last hour."
                error={minutesValid ? undefined : 'Enter a whole number from 0 to 240.'}
              >
                <input
                  id="unit-break-minutes"
                  type="number"
                  min={0}
                  max={240}
                  step={1}
                  className={`${INPUT} w-28`}
                  value={breakMinutes}
                  aria-describedby={describedBy('unit-break-minutes', {
                    hint: true,
                    error: !minutesValid,
                  })}
                  onChange={(e) => setBreakMinutes(e.target.value)}
                />
              </Field>
              <CheckField
                id="unit-charge-covers-breaks"
                label="The charge nurse relieves for breaks"
                disabled={takesPatients}
                hint="Only where the charge nurse takes no patients. California's Title 22 § 70217 allows a charge nurse without patients to relieve for breaks, which saves one relief nurse."
                tip="Ticked, one fewer relief nurse is added to each shift, since the charge nurse covers the bedside while a nurse is on break."
              >
                <input
                  id="unit-charge-covers-breaks"
                  type="checkbox"
                  checked={!takesPatients && coversBreaks}
                  disabled={takesPatients}
                  aria-describedby={describedBy('unit-charge-covers-breaks', { hint: true })}
                  onChange={(e) => setCoversBreaks(e.target.checked)}
                />
              </CheckField>
            </fieldset>
            {update.isSuccess && !dirty ? (
              <p role="status" className="text-sm text-success">
                Saved.
              </p>
            ) : null}
          </form>
        </section>
      </EditorShell>

      <section className="rounded-md border border-border bg-surface p-4">
        <StateLawSection />
      </section>

      <section className="rounded-md border border-border bg-surface p-4">
        <h2 className="mb-1 text-sm font-semibold text-text">Setup guide</h2>
        <p className="mb-3 text-sm text-text-muted">
          Walk through shifts, staffing floors, ratios, holidays, rules, pay and roster again.
          Nothing already set up is removed.
        </p>
        <button
          type="button"
          className={SECONDARY}
          disabled={resume.isPending}
          onClick={() => resume.mutate()}
        >
          Open the setup guide
        </button>
        {resume.isError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {errorMessage(resume.error)}
          </p>
        ) : null}
      </section>

      <section className="rounded-md border border-danger/50 bg-surface p-4">
        <h2 className="mb-1 text-sm font-semibold text-text">Start over</h2>
        <p className="mb-3 text-sm text-text-muted">
          Delete all data and return to the welcome screen, for example to leave the demo and set up
          your real unit. A backup is saved first.
        </p>
        <button
          type="button"
          className={DANGER}
          disabled={startOver.isPending || startOver.isSuccess}
          onClick={() => void onStartOver()}
          data-testid="start-over"
        >
          {startOver.isPending || startOver.isSuccess ? 'Restarting…' : 'Start over'}
        </button>
        {startOver.isError ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {errorMessage(startOver.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
