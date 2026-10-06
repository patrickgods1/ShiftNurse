/**
 * Shift-type catalogue for the unit: the abbreviations, colours and start/duration pairs that
 * every other screen (grid, solver, coverage floors) reads. Deactivating rather than deleting
 * matters here specifically because a shift type is referenced by historical assignments and
 * coverage requirements — deleting it out from under them would corrupt a published schedule's
 * explainability.
 */

import type { Id, ShiftType } from '@shiftnurse/core';
import { useState } from 'react';
import type { ShiftTypeInput, ShiftTypePatch } from '../../../../shared/api.js';
import {
  useCreateShiftType,
  useDeactivateShiftType,
  useShiftTypesList,
  useUpdateShiftType,
} from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { CheckField, describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { INPUT, PRIMARY, SECONDARY } from '../../components/ui.js';
import { useUnitId } from '../../unit-context.js';

interface FormState {
  name: string;
  abbreviation: string;
  startTime: string;
  durationHours: string;
  isNight: boolean;
  isOnCall: boolean;
  /** The id of the shift this one runs inside, or '' for a standalone shift. */
  withinShiftTypeId: string;
  color: string;
  sortOrder: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  abbreviation: '',
  startTime: '07:00',
  durationHours: '12',
  isNight: false,
  isOnCall: false,
  withinShiftTypeId: '',
  color: '#1f6f8b',
  sortOrder: '0',
};

function toFormState(shiftType: ShiftType): FormState {
  return {
    name: shiftType.name,
    abbreviation: shiftType.abbreviation,
    startTime: shiftType.startTime,
    durationHours: String(shiftType.durationHours),
    isNight: shiftType.isNight,
    isOnCall: shiftType.isOnCall,
    withinShiftTypeId: shiftType.withinShiftTypeId ?? '',
    color: shiftType.color,
    sortOrder: String(shiftType.sortOrder),
  };
}

function withinOf(form: FormState): ShiftType['withinShiftTypeId'] {
  return form.withinShiftTypeId === '' ? null : (form.withinShiftTypeId as Id);
}

function diffPatch(original: ShiftType, form: FormState): ShiftTypePatch {
  const patch: ShiftTypePatch = {};
  if (form.name !== original.name) patch.name = form.name;
  if (form.abbreviation !== original.abbreviation) patch.abbreviation = form.abbreviation;
  if (form.startTime !== original.startTime) patch.startTime = form.startTime;
  const durationHours = Number(form.durationHours);
  if (durationHours !== original.durationHours) patch.durationHours = durationHours;
  if (form.isNight !== original.isNight) patch.isNight = form.isNight;
  if (form.isOnCall !== original.isOnCall) patch.isOnCall = form.isOnCall;
  const withinShiftTypeId = withinOf(form);
  if (withinShiftTypeId !== original.withinShiftTypeId) patch.withinShiftTypeId = withinShiftTypeId;
  if (form.color !== original.color) patch.color = form.color;
  const sortOrder = Number(form.sortOrder);
  if (sortOrder !== original.sortOrder) patch.sortOrder = sortOrder;
  return patch;
}

function ShiftTypeForm({
  initial,
  containers,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  initial: FormState;
  /** Standalone shifts this one could run inside. */
  containers: readonly ShiftType[];
  onCancel: () => void;
  onSubmit: (form: FormState) => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<FormState>(initial);

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form);
      }}
    >
      <Field id="shift-name" label="Name" hint="As staff say it, such as “Day 12” or “Night 8”.">
        <input
          id="shift-name"
          type="text"
          required
          value={form.name}
          aria-describedby={describedBy('shift-name', { hint: true })}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
          className={INPUT}
        />
      </Field>
      <Field
        id="shift-abbreviation"
        label="Abbreviation"
        hint="Up to 4 characters. This is what each cell of the schedule grid and printouts shows."
      >
        <input
          id="shift-abbreviation"
          type="text"
          required
          maxLength={4}
          value={form.abbreviation}
          aria-describedby={describedBy('shift-abbreviation', { hint: true })}
          onChange={(event) => setForm({ ...form, abbreviation: event.target.value })}
          className={INPUT}
        />
      </Field>
      <div className="flex gap-3">
        <Field id="shift-start" label="Start time" className="flex-1">
          <input
            id="shift-start"
            type="time"
            required
            value={form.startTime}
            onChange={(event) => setForm({ ...form, startTime: event.target.value })}
            className={INPUT}
          />
        </Field>
        <Field
          id="shift-duration"
          label="Paid hours"
          className="flex-1"
          tip={
            'The paid length of the shift. Rest, overtime, contracted hours and cost are all ' +
            'counted from this number, so enter the hours payroll pays (for example 12 for a ' +
            '07:00–19:00 shift), not the gap between clock times.'
          }
        >
          <input
            id="shift-duration"
            type="number"
            required
            min={1}
            max={24}
            step={0.5}
            value={form.durationHours}
            onChange={(event) => setForm({ ...form, durationHours: event.target.value })}
            className={INPUT}
          />
        </Field>
      </div>
      <div className="flex gap-3">
        <Field
          id="shift-colour"
          label="Colour"
          className="flex-1"
          tip="Tints this shift on the schedule grid and dashboard so shift types are easy to tell apart."
        >
          <input
            id="shift-colour"
            type="color"
            value={form.color}
            onChange={(event) => setForm({ ...form, color: event.target.value })}
            className="h-9 w-full rounded-md border border-border bg-bg px-1"
          />
        </Field>
        <Field
          id="shift-sort"
          label="Sort order"
          className="flex-1"
          tip="Lower numbers are listed first: in the grid's shift palette, coverage floors, demand and the Today page. Day, evening, night is a common order."
        >
          <input
            id="shift-sort"
            type="number"
            required
            value={form.sortOrder}
            onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
            className={INPUT}
          />
        </Field>
      </div>
      <CheckField
        id="shift-night"
        label="Night shift"
        hint="Counts toward the consecutive-nights limit, the longer rest after nights, the night differential and the nights share in the fairness score."
        tip="Tick it for any tour your contract treats as a night or off-shift. Whether leave covers a shift is judged by its clock times instead, so this flag never changes that."
      >
        <input
          id="shift-night"
          type="checkbox"
          checked={form.isNight}
          aria-describedby={describedBy('shift-night', { hint: true })}
          onChange={(event) => setForm({ ...form, isNight: event.target.checked })}
        />
      </CheckField>
      <CheckField
        id="shift-on-call"
        label="On-call"
        hint="Standby, not worked time: paid at the on-call rate from the Pay tab, and never counted as on the floor."
        tip="Whether standby counts toward rest, consecutive days and hours is set per rule on the Rules tab. By default it does not."
      >
        <input
          id="shift-on-call"
          type="checkbox"
          checked={form.isOnCall}
          aria-describedby={describedBy('shift-on-call', { hint: true })}
          onChange={(event) => setForm({ ...form, isOnCall: event.target.checked })}
        />
      </CheckField>
      <Field
        id="shift-within"
        label="Runs inside"
        hint={
          'For a mid or short shift whose hours sit inside another, such as an 8 inside the day ' +
          '12. It is covered by whoever is on that shift: no charge nurse of its own, and that ' +
          "shift's staff count toward its credential requirements and the experienced RNs a new " +
          'grad on it works beside.'
        }
      >
        <select
          id="shift-within"
          value={form.withinShiftTypeId}
          aria-describedby={describedBy('shift-within', { hint: true })}
          onChange={(event) => setForm({ ...form, withinShiftTypeId: event.target.value })}
          className={INPUT}
        >
          <option value="">Nothing — a standalone shift</option>
          {containers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.abbreviation}, {t.startTime}, {t.durationHours}h)
            </option>
          ))}
        </select>
      </Field>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function ShiftTypeDialog({
  open,
  onOpenChange,
  title,
  initial,
  containers,
  error,
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: FormState;
  containers: readonly ShiftType[];
  /** Why main refused the last save — a shift that does not fit inside the one it names. */
  error: Error | null;
  onSubmit: (form: FormState) => void;
  submitLabel: string;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} variant="popup" size="md">
      {error ? (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error.message}
        </p>
      ) : null}
      <ShiftTypeForm
        initial={initial}
        containers={containers}
        submitLabel={submitLabel}
        onCancel={() => onOpenChange(false)}
        onSubmit={onSubmit}
      />
    </Modal>
  );
}

export default function ShiftTypesPanel() {
  const unitId = useUnitId();
  const shiftTypesQuery = useShiftTypesList(unitId);
  const createMutation = useCreateShiftType();
  const updateMutation = useUpdateShiftType();
  const deactivateMutation = useDeactivateShiftType();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ShiftType | undefined>(undefined);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState<ShiftType | undefined>(
    undefined,
  );

  if (shiftTypesQuery.isPending) {
    return <AsyncState status="loading" label="Loading shift types" />;
  }
  if (shiftTypesQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load shift types" error={shiftTypesQuery.error} />
    );
  }

  const shiftTypes = [...shiftTypesQuery.data].sort((a, b) => a.sortOrder - b.sortOrder);
  // A shift runs inside a standalone one, never itself; main refuses one whose hours do not fit.
  const containersFor = (self: ShiftType | undefined) =>
    shiftTypes.filter(
      (t) => t.withinShiftTypeId === null && t.id !== self?.id && !t.isOnCall && t.active,
    );

  function handleCreate(form: FormState) {
    const input: ShiftTypeInput = {
      unitId,
      name: form.name,
      abbreviation: form.abbreviation,
      startTime: form.startTime,
      durationHours: Number(form.durationHours),
      isNight: form.isNight,
      isOnCall: form.isOnCall,
      withinShiftTypeId: withinOf(form),
      color: form.color,
      sortOrder: Number(form.sortOrder),
      active: true,
    };
    createMutation.mutate(input, { onSuccess: () => setCreating(false) });
  }

  function handleUpdate(original: ShiftType, form: FormState) {
    const patch = diffPatch(original, form);
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
          <h2 className="text-sm font-semibold text-text">Shift types</h2>
          <p className="mt-1 max-w-prose text-sm text-text-muted">
            The shifts your unit works. Every schedule, coverage floor and pay rule refers to these.
            A shift type in use is deactivated rather than deleted, so schedules already built with
            it still read correctly.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            createMutation.reset();
            setCreating(true);
          }}
          className={`${PRIMARY} shrink-0`}
        >
          Add shift type
        </button>
      </div>

      <div
        data-testid="shift-type-table"
        className="overflow-x-auto rounded-md border border-border bg-surface"
      >
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                Abbreviation
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Start
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Duration
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Night
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                On-call
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Runs inside
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Sort
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
            {shiftTypes.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-text-muted">
                  No shift types yet.
                </td>
              </tr>
            ) : (
              shiftTypes.map((shiftType) => (
                <tr key={shiftType.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 text-text">
                    <span className="inline-flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-3 w-3 rounded-full border border-border"
                        style={{ backgroundColor: shiftType.color }}
                      />
                      {shiftType.abbreviation}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text">{shiftType.name}</td>
                  <td className="px-3 py-2 text-text">{shiftType.startTime}</td>
                  <td className="px-3 py-2 text-text">{shiftType.durationHours}h</td>
                  <td className="px-3 py-2 text-text">{shiftType.isNight ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2 text-text">{shiftType.isOnCall ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2 text-text">
                    {shiftTypes.find((t) => t.id === shiftType.withinShiftTypeId)?.abbreviation ??
                      '—'}
                  </td>
                  <td className="px-3 py-2 text-text">{shiftType.sortOrder}</td>
                  <td className="px-3 py-2 text-text">
                    {shiftType.active ? 'Active' : 'Inactive'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          updateMutation.reset();
                          setEditing(shiftType);
                        }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg"
                      >
                        Edit
                      </button>
                      {shiftType.active ? (
                        <button
                          type="button"
                          onClick={() => setConfirmingDeactivate(shiftType)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-danger hover:bg-bg"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={updateMutation.isPending}
                          onClick={() =>
                            updateMutation.mutate({ id: shiftType.id, patch: { active: true } })
                          }
                          className="rounded-md border border-border px-2 py-1 text-xs text-text hover:bg-bg disabled:opacity-50"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ShiftTypeDialog
        open={creating}
        onOpenChange={setCreating}
        title="Add shift type"
        initial={EMPTY_FORM}
        containers={containersFor(undefined)}
        error={createMutation.error}
        submitLabel="Create"
        onSubmit={handleCreate}
      />

      {editing !== undefined ? (
        <ShiftTypeDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          title="Edit shift type"
          initial={toFormState(editing)}
          containers={containersFor(editing)}
          error={updateMutation.error}
          submitLabel="Save"
          onSubmit={(form) => handleUpdate(editing, form)}
        />
      ) : null}

      <Modal
        open={confirmingDeactivate !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmingDeactivate(undefined);
        }}
        title="Deactivate shift type?"
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
            ? `"${confirmingDeactivate.name}" will no longer be offered when building new schedules. Existing assignments are unaffected, and you can reactivate it later.`
            : ''}
        </p>
      </Modal>
    </section>
  );
}
