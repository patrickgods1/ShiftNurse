/** Argument schemas for `nurses`. */

import { z } from 'zod';
import { hours, id, isoDate, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

const employmentType = z.enum(['full_time', 'part_time', 'per_diem', 'agency']);

const nurseInput = object({
  unitId: id,
  employeeId: text,
  firstName: text,
  lastName: text,
  role: nurseRole,
  employmentType,
  fte: z.number().min(0, 'must be zero or more').max(1.5, 'must be 1.5 or fewer'),
  contractedHoursPerPeriod: hours,
  seniorityDate: isoDate,
  hireDate: isoDate.optional(),
  isChargeEligible: z.boolean(),
  isNovice: z.boolean(),
  isFloatEligible: z.boolean(),
  phone: text.optional(),
  email: text.optional(),
  active: z.boolean(),
  notes: text.optional(),
});

/** A patch clears hire date, phone, email and notes with `null`; an omitted key is left alone. */
const nursePatch = nurseInput
  .omit({ unitId: true, phone: true, email: true, notes: true, hireDate: true })
  .partial()
  .extend({
    hireDate: isoDate.nullable().optional(),
    phone: text.nullable().optional(),
    email: text.nullable().optional(),
    notes: text.nullable().optional(),
  });

export const nursesSchemas = {
  list: z.tuple([id]),
  get: z.tuple([id]),
  create: z.tuple([nurseInput]),
  update: z.tuple([id, nursePatch]),
  deactivate: z.tuple([id]),
} satisfies ResourceSchemas<'nurses'>;
