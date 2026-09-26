/**
 * Settings › Unit: the unit's name and type, the way back into the setup guide, and Start
 * over. The pay-period calendar is shown but not editable: contracted hours are counted per
 * pay period, and moving the calendar would re-judge every period already counted in it.
 *
 * Start over is how an evaluator leaves the demo for real data. It deletes everything, so it
 * confirms by naming what is kept: a `pre-reset` backup that Settings › Backups can restore.
 */

import { type FormEvent, useEffect, useState } from 'react';
import { useResumeSetup, useStartOver, useUpdateUnit } from '../../api-setup.js';
import { useConfirm } from '../../components/confirm.js';
import { DANGER, errorMessage, INPUT, LABEL, PRIMARY, SECONDARY } from '../../components/ui.js';
import { useUnit } from '../../unit-context.js';

export default function UnitPanel() {
  const unit = useUnit();
  const update = useUpdateUnit();
  const resume = useResumeSetup();
  const startOver = useStartOver();
  const confirm = useConfirm();
  const [name, setName] = useState(unit.name);
  const [unitType, setUnitType] = useState(unit.unitType);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the saved unit changes.
  useEffect(() => {
    setName(unit.name);
    setUnitType(unit.unitType);
  }, [unit.id, unit.name, unit.unitType]);

  const dirty = name !== unit.name || unitType !== unit.unitType;

  const save = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: unit.id, patch: { name: name.trim(), unitType: unitType.trim() } });
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
      <section className="rounded-md border border-border bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold text-text">Unit</h2>
        <form onSubmit={save} className="flex flex-col gap-3">
          <div className="grid max-w-xl grid-cols-2 gap-3">
            <label className={LABEL}>
              Name
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={LABEL}>
              Type
              <input
                className={INPUT}
                value={unitType}
                onChange={(e) => setUnitType(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-text-muted">
            Pay periods are {unit.payPeriodDays} days long, counted from {unit.payPeriodAnchor}.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className={PRIMARY}
              disabled={!dirty || name.trim() === '' || update.isPending}
            >
              Save
            </button>
            {update.isError ? (
              <span role="alert" className="text-sm text-danger">
                {errorMessage(update.error)}
              </span>
            ) : null}
          </div>
        </form>
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
