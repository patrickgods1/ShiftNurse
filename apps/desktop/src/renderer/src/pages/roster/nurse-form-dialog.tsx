/**
 * Create/edit dialog for a single nurse. One component serves both flows because the fields
 * are identical; only what happens on submit differs — a full `NurseInput` for create, a
 * minimal `NursePatch` of just the changed fields for edit; per the IPC contract, `phone`/
 * `email`/`notes` need an explicit `null` to be cleared, so the diff has to say so rather
 * than omitting the key.
 *
 * Labels name the field; hints and errors are its description (`field-help`'s `Field`), and
 * warnings never block Save.
 */

import type {
  EmploymentType,
  Id,
  IsoDate,
  Nurse,
  NurseRole,
  ScheduleKind,
  Tour,
} from '@shiftnurse/core';
import {
  compareDates,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  isIsoDate,
  SCHEDULE_KIND_LABELS,
  SCHEDULE_KINDS,
  today,
} from '@shiftnurse/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import type { NurseInput, NursePatch } from '../../../../shared/api.js';
import { useCreateNurse, useUpdateNurse } from '../../api.js';
import { DateField } from '../../components/date-field.js';
import { describedBy, Field } from '../../components/field-help.js';
import { Modal } from '../../components/modal.js';
import { PRIMARY, SECONDARY } from '../../components/ui.js';

const ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'];

const TOUR_OPTIONS: readonly { value: Tour | ''; label: string }[] = [
  { value: '', label: 'Rotates (none)' },
  { value: 'day', label: 'Day' },
  { value: 'evening', label: 'Evening' },
  { value: 'night', label: 'Night' },
];

export interface FormState {
  employeeId: string;
  firstName: string;
  lastName: string;
  role: NurseRole;
  employmentType: EmploymentType;
  fte: string;
  contractedHoursPerPeriod: string;
  seniorityDate: string;
  hireDate: string;
  permanentTour: Tour | '';
  scheduleKind: ScheduleKind | '';
  scheduledDaysPerWeek: string;
  isChargeEligible: boolean;
  isNovice: boolean;
  isFloatEligible: boolean;
  phone: string;
  email: string;
  notes: string;
}

function blankForm(payPeriodDays: number): FormState {
  return {
    employeeId: '',
    firstName: '',
    lastName: '',
    role: 'RN',
    employmentType: 'full_time',
    fte: '1.0',
    // Worked out from the FTE so the field is never blank on a new nurse (see the hint).
    contractedHoursPerPeriod: String(defaultContractedHours(1, payPeriodDays)),
    seniorityDate: '',
    hireDate: '',
    permanentTour: '',
    scheduleKind: '',
    scheduledDaysPerWeek: '',
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
    hireDate: nurse.hireDate ?? '',
    permanentTour: nurse.permanentTour ?? '',
    scheduleKind: nurse.scheduleKind ?? '',
    scheduledDaysPerWeek:
      nurse.scheduledDaysPerWeek === undefined ? '' : String(nurse.scheduledDaysPerWeek),
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

/**
 * What the plan's nurse actually works in one pay period. The app judges contracted hours on
 * hours worked, so these are the worked figures (72 of the paid 80; 24 a week of the paid 40).
 */
function plannedWorked(
  kind: ScheduleKind | '',
  payPeriodDays: number,
): { fte: number; hours: number } | undefined {
  if (kind === 'va_72_80') return { fte: 0.9, hours: Math.round((72 * payPeriodDays) / 14) };
  if (kind === 'va_baylor') return { fte: 1, hours: Math.round((24 * payPeriodDays) / 7) };
  return undefined;
}

interface FieldErrors {
  employeeId?: string;
  firstName?: string;
  lastName?: string;
  fte?: string;
  contractedHoursPerPeriod?: string;
  seniorityDate?: string;
  scheduledDaysPerWeek?: string;
  email?: string;
}

const FOCUS_ORDER: readonly (keyof FieldErrors)[] = [
  'employeeId',
  'firstName',
  'lastName',
  'fte',
  'contractedHoursPerPeriod',
  'seniorityDate',
  'scheduledDaysPerWeek',
  'email',
];

function validate(form: FormState, payPeriodDays: number): FieldErrors {
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
  } else if (hours > payPeriodDays * 24) {
    errors.contractedHoursPerPeriod = `Contracted hours must be ${payPeriodDays * 24} or fewer (24 hours a day for a ${payPeriodDays}-day pay period).`;
  }

  if (form.scheduledDaysPerWeek.trim() !== '') {
    const days = Number(form.scheduledDaysPerWeek);
    if (!Number.isInteger(days) || days < 1 || days > 7) {
      errors.scheduledDaysPerWeek = 'Scheduled days per week must be a whole number from 1 to 7.';
    }
  }

  if (!form.seniorityDate) errors.seniorityDate = 'Seniority date is required.';

  if (form.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
    errors.email = 'Email address looks invalid.';
  }

  return errors;
}

/** Things that look wrong but are the manager's call; they never stop Save. */
export function warnings(form: FormState, _payPeriodDays: number, todayIso: IsoDate): string[] {
  const out: string[] = [];
  const type = form.employmentType;
  const hours = Number(form.contractedHoursPerPeriod);
  if ((type === 'full_time' || type === 'part_time') && Number(form.fte) === 0) {
    out.push(
      `A ${EMPLOYMENT_TYPE_LABELS[type].toLowerCase()} nurse at FTE 0 has no contracted hours.`,
    );
  }
  if (isIsoDate(form.seniorityDate) && compareDates(form.seniorityDate, todayIso) > 0) {
    out.push('The seniority date is in the future.');
  }
  if (isIsoDate(form.hireDate) && compareDates(form.hireDate, todayIso) > 0) {
    out.push('The hire date is in the future; fine for a nurse who has not started yet.');
  }
  if ((type === 'per_diem' || type === 'agency') && hours > 0) {
    out.push(
      `${EMPLOYMENT_TYPE_LABELS[type]} staff have no contracted minimum; the under-hours check skips them.`,
    );
  }
  return out;
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
  const [form, setForm] = useState<FormState>(() =>
    nurse ? formFromNurse(nurse) : blankForm(payPeriodDays),
  );
  const [hoursTouched, setHoursTouched] = useState(isEdit);
  const [errors, setErrors] = useState<FieldErrors>({});
  const formId = useId();
  const fid = (name: string) => `${formId}-${name}`;
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
    setForm(nurse ? formFromNurse(nurse) : blankForm(payPeriodDays));
    setHoursTouched(isEdit);
    setErrors({});
    createNurse.reset();
    updateNurse.reset();
  }, [open, nurse]);

  const warningList = warnings(form, payPeriodDays, today());

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (!hoursTouched) {
        const type = next.employmentType;
        const paid = type === 'full_time' || type === 'part_time';
        // Per-diem and agency staff have no contracted minimum, so an FTE edit must not give
        // them one; switching back to a contracted type works it out from the current FTE.
        if (key === 'employmentType' && !paid) next.contractedHoursPerPeriod = '0';
        else if ((key === 'fte' || key === 'employmentType') && paid) {
          const fte = Number(next.fte);
          if (!Number.isNaN(fte)) {
            next.contractedHoursPerPeriod = String(defaultContractedHours(fte, payPeriodDays));
          }
        }
      }
      return next;
    });
  }

  // Only on the manager's change, never on load: an existing nurse's numbers are her contract.
  function changeScheduleKind(kind: ScheduleKind | '') {
    const planned = plannedWorked(kind, payPeriodDays);
    setForm((prev) => ({
      ...prev,
      scheduleKind: kind,
      ...(planned
        ? { fte: String(planned.fte), contractedHoursPerPeriod: String(planned.hours) }
        : {}),
    }));
    if (planned) setHoursTouched(true);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors = validate(form, payPeriodDays);
    setErrors(fieldErrors);
    const firstInvalid = FOCUS_ORDER.find((key) => fieldErrors[key] !== undefined);
    if (firstInvalid !== undefined) {
      document.getElementById(`${formId}-${firstInvalid}`)?.focus();
      return;
    }

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
      // Emptying the box clears it; `null` says so, where an omitted key would leave it alone.
      if (form.hireDate !== initial.hireDate) {
        patch.hireDate = form.hireDate === '' ? null : (form.hireDate as IsoDate);
      }
      if (form.permanentTour !== initial.permanentTour) {
        patch.permanentTour = form.permanentTour === '' ? null : form.permanentTour;
      }
      if (form.scheduleKind !== initial.scheduleKind) {
        patch.scheduleKind = form.scheduleKind === '' ? null : form.scheduleKind;
      }
      if (form.scheduledDaysPerWeek !== initial.scheduledDaysPerWeek) {
        patch.scheduledDaysPerWeek =
          form.scheduledDaysPerWeek.trim() === '' ? null : Number(form.scheduledDaysPerWeek);
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
        ...(form.hireDate !== '' ? { hireDate: form.hireDate as IsoDate } : {}),
        ...(form.permanentTour !== '' ? { permanentTour: form.permanentTour } : {}),
        ...(form.scheduleKind !== '' ? { scheduleKind: form.scheduleKind } : {}),
        ...(form.scheduledDaysPerWeek.trim() !== ''
          ? { scheduledDaysPerWeek: Number(form.scheduledDaysPerWeek) }
          : {}),
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={isEdit ? `Edit ${nurse.firstName} ${nurse.lastName}` : 'Add nurse'}
    >
      <form
        id={formId}
        data-testid="nurse-form"
        className="mt-4"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="grid grid-cols-2 gap-4">
          <Field id={fid('employeeId')} label="Employee ID" error={errors.employeeId}>
            <input
              id={fid('employeeId')}
              className={inputClass}
              aria-invalid={errors.employeeId !== undefined || undefined}
              aria-describedby={describedBy(fid('employeeId'), {
                error: errors.employeeId !== undefined,
              })}
              value={form.employeeId}
              onChange={(e) => setField('employeeId', e.target.value)}
            />
          </Field>
          <Field id={fid('role')} label="Role">
            <select
              id={fid('role')}
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

          <Field id={fid('firstName')} label="First name" error={errors.firstName}>
            <input
              id={fid('firstName')}
              className={inputClass}
              aria-invalid={errors.firstName !== undefined || undefined}
              aria-describedby={describedBy(fid('firstName'), {
                error: errors.firstName !== undefined,
              })}
              value={form.firstName}
              onChange={(e) => setField('firstName', e.target.value)}
            />
          </Field>
          <Field id={fid('lastName')} label="Last name" error={errors.lastName}>
            <input
              id={fid('lastName')}
              className={inputClass}
              aria-invalid={errors.lastName !== undefined || undefined}
              aria-describedby={describedBy(fid('lastName'), {
                error: errors.lastName !== undefined,
              })}
              value={form.lastName}
              onChange={(e) => setField('lastName', e.target.value)}
            />
          </Field>

          <Field id={fid('employment')} label="Employment type">
            <select
              id={fid('employment')}
              className={inputClass}
              value={form.employmentType}
              onChange={(e) => setField('employmentType', e.target.value as EmploymentType)}
            >
              {EMPLOYMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {EMPLOYMENT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field id={fid('fte')} label="FTE" error={errors.fte}>
            <input
              id={fid('fte')}
              type="number"
              step="0.05"
              min={0}
              max={1.5}
              className={inputClass}
              aria-invalid={errors.fte !== undefined || undefined}
              aria-describedby={describedBy(fid('fte'), { error: errors.fte !== undefined })}
              value={form.fte}
              onChange={(e) => setField('fte', e.target.value)}
            />
          </Field>

          <Field
            id={fid('contractedHoursPerPeriod')}
            label="Contracted hours / period"
            hint={`Worked out from FTE (${defaultContractedHours(1, payPeriodDays)}h a pay period at 1.0). Change it to match the contract, e.g. 72h for three 12s a week.`}
            error={errors.contractedHoursPerPeriod}
          >
            <input
              id={fid('contractedHoursPerPeriod')}
              type="number"
              min={0}
              className={inputClass}
              aria-invalid={errors.contractedHoursPerPeriod !== undefined || undefined}
              aria-describedby={describedBy(fid('contractedHoursPerPeriod'), {
                hint: true,
                error: errors.contractedHoursPerPeriod !== undefined,
              })}
              value={form.contractedHoursPerPeriod}
              onChange={(e) => {
                setHoursTouched(true);
                setField('contractedHoursPerPeriod', e.target.value);
              }}
            />
          </Field>
          <DateField
            id={fid('seniorityDate')}
            label="Seniority date"
            value={form.seniorityDate as IsoDate | ''}
            onChange={(v) => setField('seniorityDate', v)}
            error={errors.seniorityDate}
          />
          <DateField
            id={fid('hire')}
            label="Hire date"
            hint="Only if employment began on a different day than seniority (bridged or merged service). FMLA and accrual by years of service use it."
            value={form.hireDate as IsoDate | ''}
            onChange={(v) => setField('hireDate', v)}
          />
          <Field
            id={fid('tour')}
            label="Permanent tour"
            hint="A nurse on a permanent tour is never rotated off it when the Tour rotation rule is on."
          >
            <select
              id={fid('tour')}
              aria-describedby={describedBy(fid('tour'), { hint: true })}
              className={inputClass}
              value={form.permanentTour}
              onChange={(e) => setField('permanentTour', e.target.value as Tour | '')}
            >
              {TOUR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id={fid('schedule-kind')}
            label="Schedule plan"
            hint="Sets the hours actually worked: 72/80 is six 12-hour tours a pay period, paid as 80 (38 U.S.C. § 7456A); the Baylor plan is two 12-hour weekend tours, paid as 40 hours a week (§ 7456)."
            tip="Contracted hours here are hours worked, which is what the schedule is judged on. Payroll pays the plan's full hours; the Cost page prices worked hours at the plan's hourly rate, which comes to the same money."
          >
            <select
              id={fid('schedule-kind')}
              aria-describedby={describedBy(fid('schedule-kind'), { hint: true })}
              className={inputClass}
              value={form.scheduleKind}
              onChange={(e) => changeScheduleKind(e.target.value as ScheduleKind | '')}
            >
              <option value="">Not set</option>
              {SCHEDULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {SCHEDULE_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id={fid('scheduledDaysPerWeek')}
            label="Scheduled days per week"
            hint="For a 3×12 alternative workweek enter 3: hours past 8 on an extra day price at the extra-day rate."
            error={errors.scheduledDaysPerWeek}
          >
            <input
              id={fid('scheduledDaysPerWeek')}
              type="number"
              step={1}
              min={1}
              max={7}
              className={inputClass}
              aria-invalid={errors.scheduledDaysPerWeek !== undefined || undefined}
              aria-describedby={describedBy(fid('scheduledDaysPerWeek'), {
                hint: true,
                error: errors.scheduledDaysPerWeek !== undefined,
              })}
              value={form.scheduledDaysPerWeek}
              onChange={(e) => setField('scheduledDaysPerWeek', e.target.value)}
            />
          </Field>
        </div>

        <fieldset className="mt-4 flex gap-6">
          <legend className="mb-1 text-sm font-medium text-text">On shift, this nurse can</legend>
          <Checkbox
            id={fid('charge')}
            label="Be charge nurse"
            checked={form.isChargeEligible}
            onChange={(v) => setField('isChargeEligible', v)}
          />
          <Checkbox
            id={fid('novice')}
            label="New grad (needs an experienced RN on shift)"
            checked={form.isNovice}
            onChange={(v) => setField('isNovice', v)}
          />
          <Checkbox
            id={fid('float')}
            label="Float to other units"
            checked={form.isFloatEligible}
            onChange={(v) => setField('isFloatEligible', v)}
          />
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1 text-sm font-medium text-text">Contact (optional)</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field id={fid('phone')} label="Phone">
              <input
                id={fid('phone')}
                className={inputClass}
                value={form.phone}
                onChange={(e) => setField('phone', e.target.value)}
              />
            </Field>
            <Field id={fid('email')} label="Email" error={errors.email}>
              <input
                id={fid('email')}
                type="email"
                className={inputClass}
                aria-invalid={errors.email !== undefined || undefined}
                aria-describedby={describedBy(fid('email'), { error: errors.email !== undefined })}
                value={form.email}
                onChange={(e) => setField('email', e.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <Field id={fid('notes')} label="Notes" className="mt-4">
          <textarea
            id={fid('notes')}
            className={inputClass}
            rows={2}
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
          />
        </Field>

        {warningList.length > 0 ? (
          <ul aria-label="Check before saving" className="mt-3 list-disc pl-5 text-sm text-warn">
            {warningList.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : null}

        {mutationError !== null && mutationError !== undefined ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {mutationError instanceof Error ? mutationError.message : String(mutationError)}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className={SECONDARY} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" data-testid="nurse-form-save" disabled={saving} className={PRIMARY}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add nurse'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const inputClass =
  'mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text ' +
  'focus-visible:border-accent';

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
