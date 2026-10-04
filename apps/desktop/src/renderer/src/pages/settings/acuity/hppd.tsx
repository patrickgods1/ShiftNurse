/**
 * The unit's HPPD budget: a soft target the Demand page and Dashboard report the schedule
 * against, never a constraint. Nothing in Generate reads it, and the copy says so — the first
 * version claimed it steered the solver.
 */

import { useEffect, useState } from 'react';
import { useHppdTarget, useSetHppdTarget } from '../../../api-config.js';
import { EditorShell } from '../../../components/editor-shell.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT } from '../../../components/ui.js';

export function HppdSection({ unitId }: { unitId: string }) {
  const hppdQuery = useHppdTarget(unitId);
  const setHppd = useSetHppdTarget();
  const [value, setValue] = useState('');

  // Sync the input from the loaded target once, and again whenever a fresh save comes back —
  // but never overwrite what the manager is mid-typing.
  useEffect(() => {
    if (hppdQuery.data !== undefined) {
      setValue(String(hppdQuery.data.targetHours));
    }
  }, [hppdQuery.data]);

  const parsed = Number(value);
  const valid = value !== '' && Number.isFinite(parsed) && parsed > 0;
  const dirty = hppdQuery.data === undefined || parsed !== hppdQuery.data.targetHours;
  const error = value !== '' && !valid ? 'Enter a number above 0.' : undefined;

  function submit() {
    if (!valid) return;
    setHppd.mutate({ unitId, targetHours: parsed });
  }
  function discard() {
    if (hppdQuery.data !== undefined) setValue(String(hppdQuery.data.targetHours));
    setHppd.reset();
  }

  return (
    <EditorShell
      label="HPPD target"
      dirty={hppdQuery.isSuccess && value !== '' && dirty}
      saving={setHppd.isPending}
      error={setHppd.error}
      canSave={valid}
      formId="hppd-form"
      onSave={submit}
      onDiscard={discard}
    >
      <section>
        <h2 className="mb-3 text-sm font-semibold text-text">HPPD target</h2>
        <form
          id="hppd-form"
          className="flex max-w-sm flex-col gap-3 rounded-md border border-border bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            id="hppd-target"
            label="Nursing hours per patient day"
            hint="The care hours per patient per day your budget pays for, for example 8.5."
            tip={
              'The Demand page and Dashboard compare the hours each schedule actually spends per ' +
              'patient day with this target, and show the staff it pays for on each shift. It is ' +
              'for comparison only: Generate does not use it, and it never lowers a ratio or ' +
              'coverage floor.'
            }
            error={error}
          >
            <input
              id="hppd-target"
              type="number"
              required
              min={0.01}
              step={0.1}
              value={value}
              aria-invalid={error !== undefined || undefined}
              aria-describedby={describedBy('hppd-target', {
                hint: true,
                error: error !== undefined,
              })}
              onChange={(event) => {
                setHppd.reset();
                setValue(event.target.value);
              }}
              className={INPUT}
            />
          </Field>
          {setHppd.isSuccess && !dirty ? (
            <p role="status" className="text-sm text-success">
              Saved.
            </p>
          ) : null}
        </form>
      </section>
    </EditorShell>
  );
}
