/**
 * Patient-ratio rules: hard ceilings on patients per nurse, by role and optionally by tier.
 * Deactivated, never deleted — a rule's citation is what gets quoted if a staffing decision is
 * challenged, and published schedules were staffed against it. Loosening, re-citing, moving or
 * deactivating one asks for a reason first (core's `protectedRatioChanges`, the repository's own
 * test), so the manager is asked up front rather than shown a refusal.
 */

import type { AcuityTier, RatioRole, RatioRule, Tour } from '@shiftnurse/core';
import { describeRatioChanges, NURSE_ROLES, protectedRatioChanges } from '@shiftnurse/core';
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
import { ReasonDialog } from '../../requests/reason-dialog.js';

const ALL_TIERS_VALUE = '__all__';
const EVERY_SHIFT_VALUE = '__every__';

const TOUR_LABELS: Record<Tour, string> = { day: 'Day', evening: 'Evening', night: 'Night' };

interface RatioFormState {
  role: RatioRole;
  acuityTierId: string;
  maxPatientsPerNurse: string;
  citation: string;
  /** For a licensed rule: the least share of RNs, in percent; '' for none. */
  rnSharePercent: string;
  /** A tour, or EVERY_SHIFT_VALUE for a rule that binds every shift. */
  tour: string;
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
    tour: EVERY_SHIFT_VALUE,
  };
}

function ratioToFormState(rule: RatioRule): RatioFormState {
  return {
    role: rule.role,
    acuityTierId: rule.acuityTierId ?? ALL_TIERS_VALUE,
    maxPatientsPerNurse: String(rule.maxPatientsPerNurse),
    citation: rule.citation ?? '',
    // Rounding to a whole percent would turn a stored 0.333 into 33 and save 0.33 back.
    rnSharePercent: rule.minRnShare === undefined ? '' : sharePercentText(rule.minRnShare),
    tour: rule.tour ?? EVERY_SHIFT_VALUE,
  };
}

/** A fraction as the percent the manager typed: 0.333 is 33.3, 0.5 is 50. */
function sharePercentText(share: number): string {
  return String(Number((share * 100).toFixed(6)));
}

/** The share as stored (a fraction), or undefined: only a licensed rule carries one. */
function rnShareOf(form: RatioFormState): number | undefined {
  if (form.role !== 'licensed' || form.rnSharePercent.trim() === '') return undefined;
  return Number(form.rnSharePercent) / 100;
}

function tourOfForm(form: RatioFormState): Tour | null {
  return form.tour === EVERY_SHIFT_VALUE ? null : (form.tour as Tour);
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
  // Compared as the text the form showed, so an untouched share is never re-derived from it.
  if (
    form.rnSharePercent !== ratioToFormState(original).rnSharePercent ||
    form.role !== original.role
  ) {
    const share = rnShareOf(form);
    if (share !== original.minRnShare) patch.minRnShare = share ?? null;
  }
  if (form.tour !== (original.tour ?? EVERY_SHIFT_VALUE)) {
    patch.tour = tourOfForm(form);
  }
  return patch;
}

/** The rule as the patch would leave it, for core to judge and word before anything is sent. */
function applyRatioPatch(original: RatioRule, patch: RatioRulePatch): RatioRule {
  const { citation, minRnShare, tour, ...rest } = patch;
  const merged: RatioRule = { ...original, ...rest };
  if (citation !== undefined) {
    if (citation === null) delete merged.citation;
    else merged.citation = citation;
  }
  if (minRnShare !== undefined) {
    if (minRnShare === null) delete merged.minRnShare;
    else merged.minRnShare = minRnShare;
  }
  if (tour !== undefined) {
    if (tour === null) delete merged.tour;
    else merged.tour = tour;
  }
  return merged;
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
  pending,
}: {
  tiers: AcuityTier[];
  initial: RatioFormState;
  onCancel: () => void;
  onSubmit: (form: RatioFormState) => void;
  submitLabel: string;
  /** A save is in flight: a second click would make a second identical rule. */
  pending: boolean;
}) {
  const [form, setForm] = useState<RatioFormState>(initial);
  const valid = ratioFormValid(form);
  const sortedTiers = [...tiers].sort((a, b) => a.level - b.level);

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
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
            min={0.01}
            max={100}
            step="any"
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
        id="ratio-tour"
        label="Shift"
        hint="Read from the shift's start time: day 04:00–11:59, evening 12:00–17:59, night otherwise."
        tip={
          "For a limit that differs by shift, such as Oregon's 7 patients per nursing assistant " +
          'by day and 11 at night (ORS 441.768).'
        }
      >
        <select
          id="ratio-tour"
          value={form.tour}
          aria-describedby={describedBy('ratio-tour', { hint: true })}
          onChange={(event) => setForm({ ...form, tour: event.target.value })}
          className={INPUT}
        >
          <option value={EVERY_SHIFT_VALUE}>Every shift</option>
          {(Object.keys(TOUR_LABELS) as Tour[]).map((tour) => (
            <option key={tour} value={tour}>
              {TOUR_LABELS[tour]}
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
          step="any"
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
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" disabled={!valid || pending} className={PRIMARY}>
          {pending ? 'Saving…' : submitLabel}
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
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  tiers: AcuityTier[];
  initial: RatioFormState;
  onSubmit: (form: RatioFormState) => void;
  submitLabel: string;
  pending: boolean;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} variant="popup" size="md">
      <RatioForm
        tiers={tiers}
        initial={initial}
        submitLabel={submitLabel}
        pending={pending}
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
  const [askingReason, setAskingReason] = useState<
    { original: RatioRule; patch: RatioRulePatch; description: string } | undefined
  >(undefined);
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
      ...(form.tour !== EVERY_SHIFT_VALUE ? { tour: form.tour as Tour } : {}),
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
    const merged = applyRatioPatch(original, patch);
    const changes = protectedRatioChanges(original, merged);
    if (changes.length === 0) {
      updateMutation.mutate({ id: original.id, patch }, { onSuccess: () => setEditing(undefined) });
      return;
    }
    const tierNames = Object.fromEntries(tiers.map((tier) => [tier.id, tier.name]));
    updateMutation.reset();
    setAskingReason({
      original,
      patch,
      description: `${describeRatioChanges(original, merged, changes, tierNames)}. Your reason is kept with the change.`,
    });
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
                Shift
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
                <td colSpan={7} className="px-3 py-6 text-center text-text-muted">
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
                      ? `, at least ${sharePercentText(rule.minRnShare)}% RNs`
                      : ''}
                  </td>
                  <td className="px-3 py-2 text-text">
                    {rule.acuityTierId !== null
                      ? (tierById.get(rule.acuityTierId)?.name ?? 'Unknown tier')
                      : 'All tiers'}
                  </td>
                  <td className="px-3 py-2 text-text">
                    {rule.tour !== undefined ? TOUR_LABELS[rule.tour] : 'Every shift'}
                  </td>
                  <td className="px-3 py-2 text-text">{rule.maxPatientsPerNurse}</td>
                  <td className="px-3 py-2 text-text">{rule.citation ?? '—'}</td>
                  <td className="px-3 py-2 text-text">{rule.active ? 'Active' : 'Inactive'}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
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
                          onClick={() => {
                            // A refusal for the last rule must not greet the next one.
                            deactivateMutation.reset();
                            setConfirmingDeactivate(rule);
                          }}
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
        pending={createMutation.isPending}
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
          pending={updateMutation.isPending}
          onSubmit={(form) => handleUpdate(editing, form)}
        />
      ) : null}

      <ReasonDialog
        open={askingReason !== undefined}
        onOpenChange={(open) => {
          if (!open) setAskingReason(undefined);
        }}
        title="Why change this ratio?"
        description={askingReason?.description}
        confirmLabel="Save change"
        pending={updateMutation.isPending}
        error={updateMutation.error}
        onConfirm={(reason) => {
          if (askingReason === undefined) return;
          updateMutation.mutate(
            { id: askingReason.original.id, patch: askingReason.patch, reason },
            {
              onSuccess: () => {
                setAskingReason(undefined);
                setEditing(undefined);
              },
            },
          );
        }}
      />

      <ReasonDialog
        open={confirmingDeactivate !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmingDeactivate(undefined);
        }}
        title="Deactivate ratio rule?"
        description={
          confirmingDeactivate !== undefined
            ? `This ${confirmingDeactivate.role} ceiling of 1:${confirmingDeactivate.maxPatientsPerNurse} will no longer set staffing on new schedules. Your reason is kept on the record.`
            : ''
        }
        confirmLabel="Deactivate"
        destructive
        pending={deactivateMutation.isPending}
        error={deactivateMutation.error}
        onConfirm={(reason) => {
          if (confirmingDeactivate === undefined) return;
          deactivateMutation.mutate(
            { id: confirmingDeactivate.id, reason },
            { onSuccess: () => setConfirmingDeactivate(undefined) },
          );
        }}
      />
    </section>
  );
}
