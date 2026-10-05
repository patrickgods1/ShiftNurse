/**
 * Patient-ratio rules: hard ceilings on patients per nurse, by role and optionally by tier.
 * Deactivated, never deleted — a rule's citation is what gets quoted if a staffing decision is
 * challenged, and published schedules were staffed against it.
 */

import type { AcuityTier, RatioRole, RatioRule } from '@shiftnurse/core';
import { NURSE_ROLES } from '@shiftnurse/core';
import { useState } from 'react';
import type { RatioRuleInput, RatioRulePatch } from '../../../../../shared/api.js';
import {
  useCreateRatioRule,
  useDeactivateRatioRule,
  useUpdateRatioRule,
} from '../../../api-config.js';
import { describedBy, Field } from '../../../components/field-help.js';
import { Modal } from '../../../components/modal.js';
import { INPUT, PRIMARY, SECONDARY } from '../../../components/ui.js';

const ALL_TIERS_VALUE = '__all__';

interface RatioFormState {
  role: RatioRole;
  acuityTierId: string;
  maxPatientsPerNurse: string;
  citation: string;
  /** For a licensed rule: the least share of RNs, in percent; '' for none. */
  rnSharePercent: string;
}

/** A licensed rule counts RNs and LVNs together; every other role counts itself. */
function roleLabel(role: RatioRole): string {
  return role === 'licensed' ? 'Licensed (RN + LVN)' : role;
}

function emptyRatioForm(): RatioFormState {
  return {
    role: 'RN',
    acuityTierId: ALL_TIERS_VALUE,
    maxPatientsPerNurse: '',
    citation: '',
    rnSharePercent: '',
  };
}

function ratioToFormState(rule: RatioRule): RatioFormState {
  return {
    role: rule.role,
    acuityTierId: rule.acuityTierId ?? ALL_TIERS_VALUE,
    maxPatientsPerNurse: String(rule.maxPatientsPerNurse),
    citation: rule.citation ?? '',
    rnSharePercent: rule.minRnShare === undefined ? '' : String(Math.round(rule.minRnShare * 100)),
  };
}

/** The share as stored (a fraction), or undefined: only a licensed rule carries one. */
function rnShareOf(form: RatioFormState): number | undefined {
  if (form.role !== 'licensed' || form.rnSharePercent.trim() === '') return undefined;
  return Number(form.rnSharePercent) / 100;
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
  const share = rnShareOf(form);
  if (share !== original.minRnShare) patch.minRnShare = share ?? null;
  return patch;
}

function ratioFormValid(form: RatioFormState): boolean {
  const max = Number(form.maxPatientsPerNurse);
  const share = rnShareOf(form);
  const shareValid = share === undefined || (share > 0 && share <= 1);
  return Number.isFinite(max) && max > 0 && shareValid;
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
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit(form);
      }}
    >
      <Field id="ratio-role" label="Role">
        <select
          id="ratio-role"
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value as RatioRole })}
          className={INPUT}
        >
          {NURSE_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
          <option value="licensed">{roleLabel('licensed')}</option>
        </select>
      </Field>
      {form.role === 'licensed' ? (
        <Field
          id="ratio-rn-share"
          label="Least share of RNs (%)"
          hint="RNs and LVNs count together toward this ratio; at least this share must be RNs."
          tip={
            "California's Title 22 lets LVNs be up to half of the licensed nurses, so 50. " +
            'Leave it blank if any mix of RNs and LVNs will do.'
          }
        >
          <input
            id="ratio-rn-share"
            type="number"
            min={1}
            max={100}
            step={1}
            value={form.rnSharePercent}
            aria-describedby={describedBy('ratio-rn-share', { hint: true })}
            onChange={(event) => setForm({ ...form, rnSharePercent: event.target.value })}
            className={INPUT}
          />
        </Field>
      ) : null}
      <Field
        id="ratio-tier"
        label="Acuity tier"
        hint="All tiers applies to every patient. Where several rules apply, the strictest one wins."
      >
        <select
          id="ratio-tier"
          value={form.acuityTierId}
          aria-describedby={describedBy('ratio-tier', { hint: true })}
          onChange={(event) => setForm({ ...form, acuityTierId: event.target.value })}
          className={INPUT}
        >
          <option value={ALL_TIERS_VALUE}>All tiers</option>
          {sortedTiers.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="ratio-max"
        label="Max patients per nurse"
        hint="A hard ceiling. Generate staffs each shift so no one carries more than this."
        tip={
          "Each tier's forecast patients are divided by its ceiling, the results are added up, " +
          'and the total is rounded up once, since one nurse can carry a mixed assignment. When ' +
          'that is above the coverage floor, it becomes the minimum for the shift.'
        }
      >
        <input
          id="ratio-max"
          type="number"
          required
          min={0.01}
          step={1}
          value={form.maxPatientsPerNurse}
          aria-describedby={describedBy('ratio-max', { hint: true })}
          onChange={(event) => setForm({ ...form, maxPatientsPerNurse: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field
        id="ratio-citation"
        label="Legal or contract citation"
        hint={
          'Where this ceiling comes from: the regulation or contract clause. This is the text ' +
          'quoted back if a schedule is challenged, so keep it precise or leave it blank.'
        }
      >
        <input
          id="ratio-citation"
          type="text"
          placeholder="e.g. CA Title 22 §70217"
          value={form.citation}
          aria-describedby={describedBy('ratio-citation', { hint: true })}
          onChange={(event) => setForm({ ...form, citation: event.target.value })}
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
    <Modal open={open} onOpenChange={onOpenChange} title={title} variant="popup" size="md">
      <RatioForm
        tiers={tiers}
        initial={initial}
        submitLabel={submitLabel}
        onCancel={() => onOpenChange(false)}
        onSubmit={onSubmit}
      />
    </Modal>
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
      ...(rnShareOf(form) !== undefined ? { minRnShare: rnShareOf(form)! } : {}),
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
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Patient ratios</h2>
          <p className="mt-1 max-w-prose text-sm text-text-muted">
            The most patients one nurse may carry, by role and tier. With the census forecast they
            set each shift's minimum staff; breaching one makes a schedule unsafe. A rule is
            deactivated rather than deleted, because published schedules were staffed against it.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            Show inactive
          </label>
          <button type="button" onClick={() => setCreating(true)} className={PRIMARY}>
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
                  <td className="px-3 py-2 text-text">
                    {roleLabel(rule.role)}
                    {rule.minRnShare !== undefined
                      ? `, at least ${Math.round(rule.minRnShare * 100)}% RNs`
                      : ''}
                  </td>
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

      <Modal
        open={confirmingDeactivate !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmingDeactivate(undefined);
        }}
        title="Deactivate ratio rule?"
        variant="popup"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingDeactivate(undefined)}
              className={SECONDARY}
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
          </>
        }
      >
        <p className="mt-2 text-sm text-text-muted">
          {confirmingDeactivate !== undefined
            ? `This ${confirmingDeactivate.role} ceiling of ${confirmingDeactivate.maxPatientsPerNurse} will no longer constrain new schedules. Existing assignments are unaffected.`
            : ''}
        </p>
      </Modal>
    </section>
  );
}
