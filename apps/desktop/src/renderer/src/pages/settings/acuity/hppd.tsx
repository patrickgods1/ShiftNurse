/**
 * The unit's HPPD budget: a soft target the Demand page and Dashboard report the schedule
 * against, never a constraint. Nothing in Generate reads it, and the copy says so — the first
 * version claimed it steered the solver.
 */

import { useHppdTarget, useSetHppdTarget } from '../../../api-config.js';
import { AsyncState } from '../../../components/async-state.js';
import { EditorShell } from '../../../components/editor-shell.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT } from '../../../components/ui.js';
import {
  numberFieldProblem,
  numberFieldText,
  parseNumberField,
  useFieldDraft,
} from '../../../field-values.js';

export function HppdSection({ unitId }: { unitId: string }) {
  const hppdQuery = useHppdTarget(unitId);
  if (hppdQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load the HPPD target" error={hppdQuery.error} />
    );
  }
  if (!hppdQuery.isSuccess) {
    return <AsyncState status="loading" label="Loading the HPPD target" />;
  }
  return <HppdForm unitId={unitId} saved={hppdQuery.data?.targetHours} />;
}

/** `saved` is undefined while the unit has never set a target. */
function HppdForm({ unitId, saved }: { unitId: string; saved: number | undefined }) {
  const setHppd = useSetHppdTarget();
  // The draft follows the saved target until the manager types, so a refetch never eats typing.
  const draft = useFieldDraft(numberFieldText(saved));
  const value = draft.text;

  const parsed = parseNumberField(value);
  const problem = numberFieldProblem(value, { min: 0.01 });
  const valid = problem === undefined && parsed !== undefined;
  const dirty = parsed !== undefined && parsed !== saved;
  // Blank is not an error to nag about; zero and below keep the wording that says why.
  const error =
    value.trim() === ''
      ? undefined
      : parsed !== undefined && parsed <= 0
        ? 'Enter a number above 0.'
        : problem;

  function submit() {
    if (!valid || parsed === undefined) return;
    // Back to following the saved value once it lands, so a later restore shows in the field.
    setHppd.mutate(
      { unitId, targetHours: parsed },
      { onSuccess: (saved) => draft.reset(numberFieldText(saved.targetHours)) },
    );
  }
  function discard() {
    draft.reset();
    setHppd.reset();
  }

  return (
    <EditorShell
      label="HPPD target"
      dirty={dirty}
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
                draft.setText(event.target.value);
              }}
              className={INPUT}
              {...draft.bind}
            />
          </Field>
          {saved === undefined ? (
            <p className="text-sm text-text-muted">No target set yet.</p>
          ) : null}
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
