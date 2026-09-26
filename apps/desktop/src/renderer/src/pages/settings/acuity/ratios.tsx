/**
 * Patient-ratio rules: hard ceilings on patients per nurse, by role and optionally by tier.
 * Deactivated, never deleted — a rule's citation is what gets quoted if a staffing decision is
 * challenged, and published schedules were staffed against it.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { AcuityTier, NurseRole, RatioRule } from '@shiftnurse/core';
import { NURSE_ROLES } from '@shiftnurse/core';
import { useState } from 'react';
import type { RatioRuleInput, RatioRulePatch } from '../../../../../shared/api.js';
import {
  useCreateRatioRule,
  useDeactivateRatioRule,
  useUpdateRatioRule,
} from '../../../api-config.js';
import { OVERLAY, POPUP } from '../../../components/ui.js';

const ALL_TIERS_VALUE = '__all__';

interface RatioFormState {
  role: NurseRole;
  acuityTierId: string;
  maxPatientsPerNurse: string;
  citation: string;
}

function emptyRatioForm(): RatioFormState {
  return { role: 'RN', acuityTierId: ALL_TIERS_VALUE, maxPatientsPerNurse: '', citation: '' };
}

function ratioToFormState(rule: RatioRule): RatioFormState {
  return {
    role: rule.role,
    acuityTierId: rule.acuityTierId ?? ALL_TIERS_VALUE,
    maxPatientsPerNurse: String(rule.maxPatientsPerNurse),
    citation: rule.citation ?? '',
  };
}

function diffRatioPatch(original: RatioRule, form: RatioFormState): RatioRulePatch {
  const patch: RatioRulePatch = {};
  if (form.role !== original.role) patch.role = form.role;
  const acuityTierId = form.acuityTierId === ALL_TIERS_VALUE ? null : form.acuityTierId;
  if (acuityTierId !== original.acuityTierId) patch.acuityTierId = acuityTierId;
  const maxPatientsPerNurse = Number(form.maxPatientsPerNurse);
  if (maxPatientsPerNurse !== original.maxPatientsPerNurse) {
    patch.maxPatientsPerNurse = maxPatientsPerNurse;
  }
  const originalCitation = original.citation ?? '';
  if (form.citation !== originalCitation) {
    patch.citation = form.citation === '' ? null : form.citation;
  }
  return patch;
}

function ratioFormValid(form: RatioFormState): boolean {
  const max = Number(form.maxPatientsPerNurse);
  return Number.isFinite(max) && max > 0;
}

function RatioForm({
  tiers,
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  tiers: AcuityTier[];
  initial: RatioFormState;
  onCancel: () => void;
  onSubmit: (form: RatioFormState) => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<RatioFormState>(initial);
  const valid = ratioFormValid(form);
  const sortedTiers = [...tiers].sort((a, b) => a.level - b.level);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit(form);
      }}
    >
      <label className="flex flex-col gap-1 text-sm text-text">
        Role
        <select
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value as NurseRole })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        >
          {NURSE_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Acuity tier
        <select
          value={form.acuityTierId}
          onChange={(event) => setForm({ ...form, acuityTierId: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        >
          <option value={ALL_TIERS_VALUE}>All tiers</option>
          {sortedTiers.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Max patients per nurse
        <input
          type="number"
          required
          min={0.01}
          step={1}
          value={form.maxPatientsPerNurse}
          onChange={(event) => setForm({ ...form, maxPatientsPerNurse: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Legal/contract citation
        <input
          type="text"
          placeholder="e.g. CA Title 22 §70217"
          value={form.citation}
          onChange={(event) => setForm({ ...form, citation: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
        <span className="text-xs text-text-muted">
          Where this ceiling comes from — the regulation or contract clause. This is the text that
          gets quoted back if a schedule is challenged, so leave it precise or blank.
        </span>
      </label>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90
            disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function RatioDialog({
  open,
  onOpenChange,
  title,
  tiers,
  initial,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  tiers: AcuityTier[];
  initial: RatioFormState;
  onSubmit: (form: RatioFormState) => void;
  submitLabel: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={`${POPUP} w-[420px]`}>
          <Dialog.Title className="mb-3 text-sm font-semibold text-text">{title}</Dialog.Title>
          <RatioForm
            tiers={tiers}
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

export function RatioRulesSection({
  unitId,
  tiers,
  rules,
}: {
  unitId: string;
  tiers: AcuityTier[];
  rules: RatioRule[];
}) {
  const createMutation = useCreateRatioRule();
  const updateMutation = useUpdateRatioRule();
  const deactivateMutation = useDeactivateRatioRule();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RatioRule | undefined>(undefined);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState<RatioRule | undefined>(
    undefined,
  );
  const [showInactive, setShowInactive] = useState(false);

  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const visibleRules = (showInactive ? rules : rules.filter((r) => r.active)).sort((a, b) => {
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    const tierA = a.acuityTierId !== null ? (tierById.get(a.acuityTierId)?.level ?? 0) : -1;
    const tierB = b.acuityTierId !== null ? (tierById.get(b.acuityTierId)?.level ?? 0) : -1;
    return tierA - tierB;
  });

  function handleCreate(form: RatioFormState) {
    const input: RatioRuleInput = {
      unitId,
      role: form.role,
      acuityTierId: form.acuityTierId === ALL_TIERS_VALUE ? null : form.acuityTierId,
      maxPatientsPerNurse: Number(form.maxPatientsPerNurse),
      citation: form.citation === '' ? undefined : form.citation,
      active: true,
    };
    createMutation.mutate(input, { onSuccess: () => setCreating(false) });
  }

  function handleUpdate(original: RatioRule, form: RatioFormState) {
    const patch = diffRatioPatch(original, form);
    if (Object.keys(patch).length === 0) {
      setEditing(undefined);
      return;
    }
    updateMutation.mutate({ id: original.id, patch }, { onSuccess: () => setEditing(undefined) });
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Patient ratios</h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            Show inactive
          </label>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Add ratio rule
          </button>
        </div>
      </div>

      <div
        data-testid="ratio-rule-table"
        className="overflow-x-auto rounded-md border border-border bg-surface"
      >
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Tier
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Max patients / nurse
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Citation
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Active
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRules.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                  No ratio rules yet.
                </td>
              </tr>
            ) : (
              visibleRules.map((rule) => (
                <tr
                  key={rule.id}
                  className={`border-b border-border last:border-0 ${
                    rule.active ? '' : 'text-text-muted opacity-60'
                  }`}
                >
                  <td className="px-3 py-2 text-text">{rule.role}</td>
                  <td className="px-3 py-2 text-text">
                    {rule.acuityTierId !== null
                      ? (tierById.get(rule.acuityTierId)?.name ?? 'Unknown tier')
                      : 'All tiers'}
                  </td>
                  <td className="px-3 py-2 text-text">{rule.maxPatientsPerNurse}</td>
                  <td className="px-3 py-2 text-text">{rule.citation ?? '—'}</td>
                  <td className="px-3 py-2 text-text">{rule.active ? 'Active' : 'Inactive'}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(rule)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
                      >
                        Edit
                      </button>
                      {rule.active ? (
                        <button
                          type="button"
                          onClick={() => setConfirmingDeactivate(rule)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg"
                        >
                          Deactivate
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <RatioDialog
        open={creating}
        onOpenChange={setCreating}
        title="Add ratio rule"
        tiers={tiers}
        initial={emptyRatioForm()}
        submitLabel="Create"
        onSubmit={handleCreate}
      />

      {editing !== undefined ? (
        <RatioDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          title="Edit ratio rule"
          tiers={tiers}
          initial={ratioToFormState(editing)}
          submitLabel="Save"
          onSubmit={(form) => handleUpdate(editing, form)}
        />
      ) : null}

      <Dialog.Root
        open={confirmingDeactivate !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmingDeactivate(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={OVERLAY} />
          <Dialog.Content className={`${POPUP} w-[360px]`}>
            <Dialog.Title className="mb-2 text-sm font-semibold text-text">
              Deactivate ratio rule?
            </Dialog.Title>
            <p className="mb-4 text-sm text-text-muted">
              {confirmingDeactivate !== undefined
                ? `This ${confirmingDeactivate.role} ceiling of ${confirmingDeactivate.maxPatientsPerNurse} will no longer constrain new schedules. Existing assignments are unaffected.`
                : ''}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDeactivate(undefined)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirmingDeactivate === undefined) return;
                  deactivateMutation.mutate(confirmingDeactivate.id, {
                    onSuccess: () => setConfirmingDeactivate(undefined),
                  });
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Deactivate
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
