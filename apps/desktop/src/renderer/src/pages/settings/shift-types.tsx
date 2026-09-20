/**
 * Shift-type catalogue for the unit: the abbreviations, colours and start/duration pairs that
 * every other screen (grid, solver, coverage floors) reads. Deactivating rather than deleting
 * matters here specifically because a shift type is referenced by historical assignments and
 * coverage requirements — deleting it out from under them would corrupt a published schedule's
 * explainability.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { ShiftType } from '@shiftnurse/core';
import { useState } from 'react';
import type { ShiftTypeInput, ShiftTypePatch } from '../../../../shared/api.js';
import {
  useCreateShiftType,
  useDeactivateShiftType,
  useShiftTypesList,
  useUpdateShiftType,
} from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';

interface FormState {
  name: string;
  abbreviation: string;
  startTime: string;
  durationHours: string;
  isNight: boolean;
  isOnCall: boolean;
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
    color: shiftType.color,
    sortOrder: String(shiftType.sortOrder),
  };
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
  if (form.color !== original.color) patch.color = form.color;
  const sortOrder = Number(form.sortOrder);
  if (sortOrder !== original.sortOrder) patch.sortOrder = sortOrder;
  return patch;
}

function ShiftTypeForm({
  initial,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  initial: FormState;
  onCancel: () => void;
  onSubmit: (form: FormState) => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<FormState>(initial);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
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
        Abbreviation (up to 4 characters)
        <input
          type="text"
          required
          maxLength={4}
          value={form.abbreviation}
          onChange={(event) => setForm({ ...form, abbreviation: event.target.value })}
          className="rounded-md border border-border bg-bg px-2 py-1 text-text"
        />
      </label>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Start time
          <input
            type="time"
            required
            value={form.startTime}
            onChange={(event) => setForm({ ...form, startTime: event.target.value })}
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Duration (hours)
          <input
            type="number"
            required
            min={1}
            max={24}
            step={0.5}
            value={form.durationHours}
            onChange={(event) => setForm({ ...form, durationHours: event.target.value })}
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
      </div>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Colour
          <input
            type="color"
            value={form.color}
            onChange={(event) => setForm({ ...form, color: event.target.value })}
            className="h-9 w-full rounded-md border border-border bg-bg px-1"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm text-text">
          Sort order
          <input
            type="number"
            required
            value={form.sortOrder}
            onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
      </div>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={form.isNight}
            onChange={(event) => setForm({ ...form, isNight: event.target.checked })}
          />
          Night shift
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={form.isOnCall}
            onChange={(event) => setForm({ ...form, isOnCall: event.target.checked })}
          />
          On-call
        </label>
      </div>
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
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
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
  onSubmit,
  submitLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: FormState;
  onSubmit: (form: FormState) => void;
  submitLabel: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed z-50 left-1/2 top-1/2 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-sm font-semibold text-text">{title}</Dialog.Title>
          <ShiftTypeForm
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

  function handleCreate(form: FormState) {
    const input: ShiftTypeInput = {
      unitId,
      name: form.name,
      abbreviation: form.abbreviation,
      startTime: form.startTime,
      durationHours: Number(form.durationHours),
      isNight: form.isNight,
      isOnCall: form.isOnCall,
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
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">Shift types</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
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
                <td colSpan={9} className="px-3 py-6 text-center text-text-muted">
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
                  <td className="px-3 py-2 text-text">{shiftType.sortOrder}</td>
                  <td className="px-3 py-2 text-text">
                    {shiftType.active ? 'Active' : 'Inactive'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(shiftType)}
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
                      ) : null}
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
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content className="fixed z-50 left-1/2 top-1/2 w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface p-4 shadow-lg">
            <Dialog.Title className="mb-2 text-sm font-semibold text-text">
              Deactivate shift type?
            </Dialog.Title>
            <p className="mb-4 text-sm text-text-muted">
              {confirmingDeactivate !== undefined
                ? `"${confirmingDeactivate.name}" will no longer be offered when building new schedules. Existing assignments are unaffected.`
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
