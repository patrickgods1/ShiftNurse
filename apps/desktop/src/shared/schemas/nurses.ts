/** Argument schemas for `nurses`. */

import { z } from 'zod';
import { hours, id, isoDate, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

const tour = z.enum(['day', 'evening', 'night']);
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
  permanentTour: tour.optional(),
  scheduledDaysPerWeek: z.number().int().min(1).max(7).optional(),
  isChargeEligible: z.boolean(),
  isNovice: z.boolean(),
  isFloatEligible: z.boolean(),
  phone: text.optional(),
  email: text.optional(),
  active: z.boolean(),
  notes: text.optional(),
});

/** A patch clears hire date, permanent tour, scheduled days, phone, email and notes with `null`; an omitted key is left alone. */
const nursePatch = nurseInput
  .omit({
    unitId: true,
    phone: true,
    email: true,
    notes: true,
    hireDate: true,
    permanentTour: true,
    scheduledDaysPerWeek: true,
  })
  .partial()
  .extend({
    hireDate: isoDate.nullable().optional(),
    permanentTour: tour.nullable().optional(),
    scheduledDaysPerWeek: z.number().int().min(1).max(7).nullable().optional(),
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
