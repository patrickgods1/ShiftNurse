/**
 * Create/edit dialog for a single nurse. One component serves both flows because the fields
 * are identical; only what happens on submit differs — a full `NurseInput` for create, a
 * minimal `NursePatch` of just the changed fields for edit; per the IPC contract, `phone`/
 * `email`/`notes` need an explicit `null` to be cleared, so the diff has to say so rather
 * than omitting the key.
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { EmploymentType, Id, Nurse, NurseRole } from '@shiftnurse/core';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import type { NurseInput, NursePatch } from '../../../../shared/api.js';
import { useCreateNurse, useUpdateNurse } from '../../api.js';

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];
const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'full_time',
  'part_time',
  'per_diem',
  'agency',
];
const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  full_time: 'Full time',
  part_time: 'Part time',
  per_diem: 'Per diem',
  agency: 'Agency',
};

interface FormState {
  employeeId: string;
  firstName: string;
  lastName: string;
  role: NurseRole;
  employmentType: EmploymentType;
  fte: string;
  contractedHoursPerPeriod: string;
  seniorityDate: string;
  isChargeEligible: boolean;
  isNovice: boolean;
  isFloatEligible: boolean;
  phone: string;
  email: string;
  notes: string;
}

function blankForm(): FormState {
  return {
    employeeId: '',
    firstName: '',
    lastName: '',
    role: 'RN',
    employmentType: 'full_time',
    fte: '1.0',
    contractedHoursPerPeriod: '',
    seniorityDate: '',
    isChargeEligible: false,
    isNovice: false,
    isFloatEligible: false,
    phone: '',
    email: '',
    notes: '',
  };
}

function formFromNurse(nurse: Nurse): FormState {
  return {
    employeeId: nurse.employeeId,
    firstName: nurse.firstName,
    lastName: nurse.lastName,
    role: nurse.role,
    employmentType: nurse.employmentType,
    fte: String(nurse.fte),
    contractedHoursPerPeriod: String(nurse.contractedHoursPerPeriod),
    seniorityDate: nurse.seniorityDate,
    isChargeEligible: nurse.isChargeEligible,
    isNovice: nurse.isNovice,
    isFloatEligible: nurse.isFloatEligible,
    phone: nurse.phone ?? '',
    email: nurse.email ?? '',
    notes: nurse.notes ?? '',
  };
}

/** FTE x 40h/week x (pay period length / 7), rounded — the same default the CSV importer uses. */
function defaultContractedHours(fte: number, payPeriodDays: number): number {
  return Math.round(fte * 40 * (payPeriodDays / 7));
}

interface FieldErrors {
  employeeId?: string;
  firstName?: string;
  lastName?: string;
  fte?: string;
  contractedHoursPerPeriod?: string;
  seniorityDate?: string;
  email?: string;
}

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.employeeId.trim()) errors.employeeId = 'Employee ID is required.';
  if (!form.firstName.trim()) errors.firstName = 'First name is required.';
  if (!form.lastName.trim()) errors.lastName = 'Last name is required.';

  const fte = Number(form.fte);
  if (form.fte.trim() === '' || Number.isNaN(fte)) errors.fte = 'FTE must be a number.';
  else if (fte < 0 || fte > 1.5) errors.fte = 'FTE must be between 0 and 1.5.';

  const hours = Number(form.contractedHoursPerPeriod);
  if (form.contractedHoursPerPeriod.trim() === '' || Number.isNaN(hours) || hours < 0) {
    errors.contractedHoursPerPeriod = 'Contracted hours must be a non-negative number.';
  }

  if (!form.seniorityDate) errors.seniorityDate = 'Seniority date is required.';

  if (form.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
    errors.email = 'Email address looks invalid.';
  }

  return errors;
}

interface NurseFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: Id;
  payPeriodDays: number;
  /** Present to edit that nurse; absent to create a new one. */
  nurse?: Nurse;
}

export function NurseFormDialog({
  open,
  onOpenChange,
  unitId,
  payPeriodDays,
  nurse,
}: NurseFormDialogProps) {
  const isEdit = nurse !== undefined;
  const [form, setForm] = useState<FormState>(() => (nurse ? formFromNurse(nurse) : blankForm()));
  const [hoursTouched, setHoursTouched] = useState(isEdit);
  const [errors, setErrors] = useState<FieldErrors>({});
  const formId = useId();
  const createNurse = useCreateNurse(unitId);
  const updateNurse = useUpdateNurse(unitId);
  const saving = createNurse.isPending || updateNurse.isPending;
  const mutationError = createNurse.error ?? updateNurse.error;

  // Reset local state whenever the dialog opens for a (possibly different) nurse. `reset` is
  // intentionally left out of the dependency list: the mutation objects are recreated every
  // render, so including them would re-run this on every render instead of only on open/nurse
  // changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    if (!open) return;
    setForm(nurse ? formFromNurse(nurse) : blankForm());
    setHoursTouched(isEdit);
    setErrors({});
    createNurse.reset();
    updateNurse.reset();
  }, [open, nurse]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'fte' && !hoursTouched) {
        const fte = Number(value);
        if (!Number.isNaN(fte)) {
          next.contractedHoursPerPeriod = String(defaultContractedHours(fte, payPeriodDays));
        }
      }
      return next;
    });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors = validate(form);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    const fte = Number(form.fte);
    const contractedHoursPerPeriod = Number(form.contractedHoursPerPeriod);
    const phone = form.phone.trim() || undefined;
    const email = form.email.trim() || undefined;
    const notes = form.notes.trim() || undefined;

    if (isEdit) {
      const initial = formFromNurse(nurse);
      const patch: NursePatch = {};
      if (form.employeeId !== initial.employeeId) patch.employeeId = form.employeeId.trim();
      if (form.firstName !== initial.firstName) patch.firstName = form.firstName.trim();
      if (form.lastName !== initial.lastName) patch.lastName = form.lastName.trim();
      if (form.role !== initial.role) patch.role = form.role;
      if (form.employmentType !== initial.employmentType)
        patch.employmentType = form.employmentType;
      if (fte !== nurse.fte) patch.fte = fte;
      if (contractedHoursPerPeriod !== nurse.contractedHoursPerPeriod) {
        patch.contractedHoursPerPeriod = contractedHoursPerPeriod;
      }
      if (form.seniorityDate !== initial.seniorityDate) {
        patch.seniorityDate = form.seniorityDate as Nurse['seniorityDate'];
      }
      if (form.isChargeEligible !== initial.isChargeEligible) {
        patch.isChargeEligible = form.isChargeEligible;
      }
      if (form.isNovice !== initial.isNovice) patch.isNovice = form.isNovice;
      if (form.isFloatEligible !== initial.isFloatEligible) {
        patch.isFloatEligible = form.isFloatEligible;
      }
      if ((nurse.phone ?? '') !== form.phone.trim()) patch.phone = phone ?? null;
      if ((nurse.email ?? '') !== form.email.trim()) patch.email = email ?? null;
      if ((nurse.notes ?? '') !== form.notes.trim()) patch.notes = notes ?? null;

      updateNurse.mutate({ id: nurse.id, patch }, { onSuccess: () => onOpenChange(false) });
    } else {
      const input: NurseInput = {
        unitId,
        employeeId: form.employeeId.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        role: form.role,
        employmentType: form.employmentType,
        fte,
        contractedHoursPerPeriod,
        seniorityDate: form.seniorityDate as Nurse['seniorityDate'],
        isChargeEligible: form.isChargeEligible,
        isNovice: form.isNovice,
        isFloatEligible: form.isFloatEligible,
        phone,
        email,
        notes,
        active: true,
      };
      createNurse.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 max-h-[85vh] w-[560px] -translate-x-1/2 -translate-y-1/2
            overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-lg"
        >
          <Dialog.Title className="mb-4 text-lg font-semibold text-text">
            {isEdit ? `Edit ${nurse.firstName} ${nurse.lastName}` : 'Add nurse'}
          </Dialog.Title>

          <form id={formId} data-testid="nurse-form" onSubmit={handleSubmit} noValidate>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Employee ID" error={errors.employeeId} htmlFor={`${formId}-empid`}>
                <input
                  id={`${formId}-empid`}
                  className={inputClass}
                  value={form.employeeId}
                  onChange={(e) => setField('employeeId', e.target.value)}
                />
              </Field>
              <Field label="Role" htmlFor={`${formId}-role`}>
                <select
                  id={`${formId}-role`}
                  className={inputClass}
                  value={form.role}
                  onChange={(e) => setField('role', e.target.value as NurseRole)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="First name" error={errors.firstName} htmlFor={`${formId}-first`}>
                <input
                  id={`${formId}-first`}
                  className={inputClass}
                  value={form.firstName}
                  onChange={(e) => setField('firstName', e.target.value)}
                />
              </Field>
              <Field label="Last name" error={errors.lastName} htmlFor={`${formId}-last`}>
                <input
                  id={`${formId}-last`}
                  className={inputClass}
                  value={form.lastName}
                  onChange={(e) => setField('lastName', e.target.value)}
                />
              </Field>

              <Field label="Employment type" htmlFor={`${formId}-employment`}>
                <select
                  id={`${formId}-employment`}
                  className={inputClass}
                  value={form.employmentType}
                  onChange={(e) => setField('employmentType', e.target.value as EmploymentType)}
                >
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {EMPLOYMENT_LABELS[type]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="FTE" error={errors.fte} htmlFor={`${formId}-fte`}>
                <input
                  id={`${formId}-fte`}
                  type="number"
                  step="0.05"
                  min={0}
                  max={1.5}
                  className={inputClass}
                  value={form.fte}
                  onChange={(e) => setField('fte', e.target.value)}
                />
              </Field>

              <Field
                label="Contracted hours / period"
                error={errors.contractedHoursPerPeriod}
                htmlFor={`${formId}-hours`}
              >
                <input
                  id={`${formId}-hours`}
                  type="number"
                  min={0}
                  className={inputClass}
                  value={form.contractedHoursPerPeriod}
                  onChange={(e) => {
                    setHoursTouched(true);
                    setField('contractedHoursPerPeriod', e.target.value);
                  }}
                />
              </Field>
              <Field
                label="Seniority date"
                error={errors.seniorityDate}
                htmlFor={`${formId}-seniority`}
              >
                <input
                  id={`${formId}-seniority`}
                  type="date"
                  className={inputClass}
                  value={form.seniorityDate}
                  onChange={(e) => setField('seniorityDate', e.target.value)}
                />
              </Field>

              <Field label="Phone" htmlFor={`${formId}-phone`}>
                <input
                  id={`${formId}-phone`}
                  className={inputClass}
                  value={form.phone}
                  onChange={(e) => setField('phone', e.target.value)}
                />
              </Field>
              <Field label="Email" error={errors.email} htmlFor={`${formId}-email`}>
                <input
                  id={`${formId}-email`}
                  type="email"
                  className={inputClass}
                  value={form.email}
                  onChange={(e) => setField('email', e.target.value)}
                />
              </Field>
            </div>

            <fieldset className="mt-4 flex gap-6">
              <legend className="mb-1 text-sm font-medium text-text">Flags</legend>
              <Checkbox
                id={`${formId}-charge`}
                label="Charge eligible"
                checked={form.isChargeEligible}
                onChange={(v) => setField('isChargeEligible', v)}
              />
              <Checkbox
                id={`${formId}-novice`}
                label="Novice"
                checked={form.isNovice}
                onChange={(v) => setField('isNovice', v)}
              />
              <Checkbox
                id={`${formId}-float`}
                label="Float eligible"
                checked={form.isFloatEligible}
                onChange={(v) => setField('isFloatEligible', v)}
              />
            </fieldset>

            <Field label="Notes" htmlFor={`${formId}-notes`} className="mt-4">
              <textarea
                id={`${formId}-notes`}
                className={inputClass}
                rows={2}
                value={form.notes}
                onChange={(e) => setField('notes', e.target.value)}
              />
            </Field>

            {mutationError !== null && mutationError !== undefined ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {mutationError instanceof Error ? mutationError.message : String(mutationError)}
              </p>
            ) : null}

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                data-testid="nurse-form-save"
                disabled={saving}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white
                  disabled:opacity-60"
              >
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add nurse'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text ' +
  'focus-visible:border-accent';

function Field({
  label,
  htmlFor,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={`block text-sm text-text-muted ${className ?? ''}`}>
      {label}
      {children}
      {error !== undefined ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

function Checkbox({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-text">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
