/**
 * Acuity tiers: the named levels of patient need and the care hours each carries per patient
 * day. Deleting one is refused while ratio rules or census rows still cite it.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { AcuityTier } from '@shiftnurse/core';
import { useState } from 'react';
import type { AcuityTierInput, AcuityTierPatch } from '../../../../../shared/api.js';
import {
  useCreateAcuityTier,
  useDeleteAcuityTier,
  useUpdateAcuityTier,
} from '../../../api-config.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { INPUT, OVERLAY, POPUP, PRIMARY, SECONDARY } from '../../../components/ui.js';

interface TierFormState {
  name: string;
  level: string;
  careHoursPerPatientDay: string;
}

const EMPTY_TIER_FORM: TierFormState = { name: '', level: '1', careHoursPerPatientDay: '' };

function tierToFormState(tier: AcuityTier): TierFormState {
  return {
    name: tier.name,
    level: String(tier.level),
    careHoursPerPatientDay: String(tier.careHoursPerPatientDay),
  };
}

function diffTierPatch(original: AcuityTier, form: TierFormState): AcuityTierPatch {
  const patch: AcuityTierPatch = {};
  if (form.name !== original.name) patch.name = form.name;
  const level = Number(form.level);
  if (level !== original.level) patch.level = level;
  const careHoursPerPatientDay = Number(form.careHoursPerPatientDay);
  if (careHoursPerPatientDay !== original.careHoursPerPatientDay) {
    patch.careHoursPerPatientDay = careHoursPerPatientDay;
  }
  return patch;
}

function tierFormValid(form: TierFormState): boolean {
  const level = Number(form.level);
  const careHours = Number(form.careHoursPerPatientDay);
  return (
    form.name.trim() !== '' &&
    Number.isInteger(level) &&
    level >= 1 &&
    Number.isFinite(careHours) &&
    careHours > 0
  );
}

function TierForm({
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  initial: TierFormState;
  onCancel: () => void;
  onSubmit: (form: TierFormState) => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<TierFormState>(initial);
  const valid = tierFormValid(form);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit(form);
      }}
    >
      <Field id="tier-name" label="Name" hint="As your unit says it, such as “Stable” or “High”.">
        <input
          id="tier-name"
          type="text"
          required
          value={form.name}
          aria-describedby={describedBy('tier-name', { hint: true })}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field
        id="tier-level"
        label="Level"
        hint="1 for the least sick patients. It orders the tiers in lists and census entry."
      >
        <input
          id="tier-level"
          type="number"
          required
          min={1}
          step={1}
          value={form.level}
          aria-describedby={describedBy('tier-level', { hint: true })}
          onChange={(event) => setForm({ ...form, level: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field
        id="tier-care-hours"
        label="Care hours per patient day"
        hint="Nursing care hours one patient at this tier needs in a day."
        tip={
          'Take it from your acuity tool or unit standard. The Demand page adds it up over the ' +
          'census to show the staff each shift’s patients need, beside what the HPPD budget pays ' +
          'for. It is advisory: the patient ratios and coverage floors set the minimum.'
        }
      >
        <input
          id="tier-care-hours"
          type="number"
          required
          min={0.01}
          step={0.1}
          value={form.careHoursPerPatientDay}
          aria-describedby={describedBy('tier-care-hours', { hint: true })}
          onChange={(event) => setForm({ ...form, careHoursPerPatientDay: event.target.value })}
          className={INPUT}
        />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" disabled={!valid} className={PRIMARY}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function TierDialog({
  open,
  onOpenChange,
  title,
  initial,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: TierFormState;
  onSubmit: (form: TierFormState) => void;
  submitLabel: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={`${POPUP} w-[420px]`}>
          <Dialog.Title className="mb-3 text-sm font-semibold text-text">{title}</Dialog.Title>
          <TierForm
            initial={initial}
            submitLabel={submitLabel}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AcuityTiersSection({ unitId, tiers }: { unitId: string; tiers: AcuityTier[] }) {
  const createMutation = useCreateAcuityTier();
  const updateMutation = useUpdateAcuityTier();
  const deleteMutation = useDeleteAcuityTier();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AcuityTier | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState<AcuityTier | undefined>(undefined);

  const sorted = [...tiers].sort((a, b) => a.level - b.level);

  function handleCreate(form: TierFormState) {
    const input: AcuityTierInput = {
      unitId,
      name: form.name,
      level: Number(form.level),
      careHoursPerPatientDay: Number(form.careHoursPerPatientDay),
    };
    createMutation.mutate(input, { onSuccess: () => setCreating(false) });
  }

  function handleUpdate(original: AcuityTier, form: TierFormState) {
    const patch = diffTierPatch(original, form);
    if (Object.keys(patch).length === 0) {
      setEditing(undefined);
      return;
    }
    updateMutation.mutate({ id: original.id, patch }, { onSuccess: () => setEditing(undefined) });
  }

  return (
    <section>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Acuity tiers</h2>
          <p className="mt-1 max-w-prose text-sm text-text-muted">
            How sick patients are, in levels. The census on the Demand page is entered per tier, and
            patient ratios can be set per tier.
          </p>
        </div>
        <button type="button" onClick={() => setCreating(true)} className={PRIMARY}>
          Add tier
        </button>
      </div>

      <div
        data-testid="acuity-tier-table"
        className="overflow-x-auto rounded-md border border-border bg-surface"
      >
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Level
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Care hours / patient day
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                  No acuity tiers yet.
                </td>
              </tr>
            ) : (
              sorted.map((tier) => (
                <tr key={tier.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-text">{tier.level}</td>
                  <td className="px-3 py-2 text-text">{tier.name}</td>
                  <td className="px-3 py-2 text-text">{tier.careHoursPerPatientDay}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(tier)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(tier)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <TierDialog
        open={creating}
        onOpenChange={setCreating}
        title="Add acuity tier"
        initial={EMPTY_TIER_FORM}
        submitLabel="Create"
        onSubmit={handleCreate}
      />

      {editing !== undefined ? (
        <TierDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          title="Edit acuity tier"
          initial={tierToFormState(editing)}
          submitLabel="Save"
          onSubmit={(form) => handleUpdate(editing, form)}
        />
      ) : null}

      <Dialog.Root
        open={confirmingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY} />
          <Dialog.Content className={`${POPUP} w-[360px]`}>
            <Dialog.Title className="mb-2 text-sm font-semibold text-text">
              Delete acuity tier?
            </Dialog.Title>
            <p className="mb-4 text-sm text-text-muted">
              {confirmingDelete !== undefined
                ? `"${confirmingDelete.name}" will be removed. Any ratio rule or census mix that references it should be updated first.`
                : ''}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(undefined)}
                className={SECONDARY}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmingDelete === undefined) return;
                  deleteMutation.mutate(
                    { id: confirmingDelete.id, unitId },
                    { onSuccess: () => setConfirmingDelete(undefined) },
                  );
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Delete
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
