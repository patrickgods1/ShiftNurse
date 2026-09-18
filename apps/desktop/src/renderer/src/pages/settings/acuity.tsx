/**
 * Acuity configuration: the tiers, patient-ratio ceilings and HPPD budget that
 * `acuity/demand.ts` turns into per-shift staffing minimums (see that module's header for how
 * the three combine). Ratio rules are deactivated rather than deleted — like shift types, they
 * may be cited by the demand math behind an already-published schedule, and a rule's citation
 * text is exactly what a manager would quote back if a staffing decision were challenged, so
 * the historical record has to stay intact.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { AcuityTier, NurseRole, RatioRule } from '@shiftnurse/core';
import { NURSE_ROLES } from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import type {
  AcuityTierInput,
  AcuityTierPatch,
  RatioRuleInput,
  RatioRulePatch,
} from '../../../../shared/api.js';
import {
  useAcuityTiers,
  useCreateAcuityTier,
  useCreateRatioRule,
  useDeactivateRatioRule,
  useDeleteAcuityTier,
  useHppdTarget,
  useRatioRules,
  useSetHppdTarget,
  useUpdateAcuityTier,
  useUpdateRatioRule,
} from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';

// ---------------------------------------------------------------------------
// Acuity tiers
// ---------------------------------------------------------------------------

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
      <label className="flex flex-col gap-1 text-sm text-text">
        Name
        <input
          type="text"
          required
          value={form.name}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Level (1 = lowest acuity)
        <input
          type="number"
          required
          min={1}
          step={1}
          value={form.level}
          onChange={(event) => setForm({ ...form, level: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-text">
        Care hours per patient day
        <input
          type="number"
          required
          min={0.01}
          step={0.1}
          value={form.careHoursPerPatientDay}
          onChange={(event) => setForm({ ...form, careHoursPerPatientDay: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
        <span className="text-xs text-text-muted">
          Nursing care hours a single patient at this tier needs per day. Feeds the HPPD calculation
          and derived staffing demand.
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
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
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

function AcuityTiersSection({ unitId, tiers }: { unitId: string; tiers: AcuityTier[] }) {
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
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Acuity tiers</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
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
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
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
                className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
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

// ---------------------------------------------------------------------------
// Ratio rules
// ---------------------------------------------------------------------------

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
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
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

function RatioRulesSection({
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
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
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

// ---------------------------------------------------------------------------
// HPPD target
// ---------------------------------------------------------------------------

function HppdSection({ unitId }: { unitId: string }) {
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

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-text">HPPD target</h2>
      <form
        className="flex max-w-sm flex-col gap-2 rounded-md border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setHppd.mutate({ unitId, targetHours: parsed });
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-text">
          Target nursing hours per patient day
          <input
            type="number"
            required
            min={0.01}
            step={0.1}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <p className="text-xs text-text-muted">
          A soft budget target, e.g. 8.5 — it informs the objective function and dashboard, but it
          never becomes a hard constraint the way a patient ratio or coverage floor does.
        </p>
        <div className="mt-1 flex justify-end">
          <button
            type="submit"
            disabled={!valid}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90
              disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AcuityPanel() {
  const unitId = useUnitId();
  const tiersQuery = useAcuityTiers(unitId);
  const rulesQuery = useRatioRules(unitId);

  if (tiersQuery.isPending || rulesQuery.isPending) {
    return <AsyncState status="loading" label="Loading acuity configuration" />;
  }
  if (tiersQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load acuity tiers" error={tiersQuery.error} />
    );
  }
  if (rulesQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load ratio rules" error={rulesQuery.error} />
    );
  }

  return (
    <div data-testid="acuity-panel" className="flex flex-col gap-8">
      <AcuityTiersSection unitId={unitId} tiers={tiersQuery.data} />
      <RatioRulesSection unitId={unitId} tiers={tiersQuery.data} rules={rulesQuery.data} />
      <HppdSection unitId={unitId} />
    </div>
  );
}
