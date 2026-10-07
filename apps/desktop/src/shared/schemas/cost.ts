/** Argument schemas for `cost` — the reference pattern for every resource's schemas. */

import { z } from 'zod';
import {
  hours,
  id,
  isoDate,
  money,
  multiplier,
  nurseRole,
  object,
  type ResourceSchemas,
  timeOfDay,
} from './primitives.js';

const differentialKind = z.enum([
  'night',
  'evening',
  'weekend',
  'holiday',
  'major_holiday',
  'consecutive_shift',
  'charge',
  'on_call',
  'call_back',
  'agency',
]);
const differentialMode = z.enum(['multiplier', 'flat']);
const overtimeBasis = z.enum([
  'daily',
  'weekly',
  'pay_period',
  'seventh_day',
  'beyond_scheduled_tour',
  'consecutive',
  'beyond_scheduled_days',
  'weekend',
]);

/** A rate belongs to one nurse or to a role's default — the repository refuses both or neither. */
const payRateInput = object({
  nurseId: id.nullable(),
  role: nurseRole.nullable(),
  hourlyRate: money,
  effectiveFrom: isoDate,
});

/** Earned by clock time (`Differential.window`); the repository refuses it on other kinds. */
const differentialWindow = object({
  startTime: timeOfDay,
  endTime: timeOfDay,
  wholeShiftAtHours: z.number().positive('must be more than 0').nullable(),
});

/**
 * A consecutive-shift premium's trigger (`Differential.consecutive`): both numbers or none, whole
 * shifts and days; the repository refuses it on other kinds.
 */
const differentialConsecutive = object({
  afterShifts: z.number().int('must be a whole number').min(1, 'must be at least 1'),
  withinDays: z.number().int('must be a whole number').min(1, 'must be at least 1'),
});

const differentialInput = object({
  unitId: id,
  kind: differentialKind,
  mode: differentialMode,
  amount: money,
  active: z.boolean(),
  window: differentialWindow.optional(),
  consecutive: differentialConsecutive.optional(),
});

const overtimeRuleInput = object({
  unitId: id,
  basis: overtimeBasis,
  // A daily threshold is a few hours, a pay-period one up to 80 or more. Zero is meaningful: a
  // seventh-day rule pays its premium from the first hour.
  thresholdHours: z.number().min(0, 'must not be negative'),
  multiplier,
  active: z.boolean(),
  pyramiding: z.enum(['stack', 'none']).optional(),
  minimumMinutes: z.number().int().min(0).max(240).optional(),
  scheduleKinds: z
    .array(z.enum(['standard', 'va_72_80', 'va_baylor']))
    .min(1)
    .optional(),
  tourDays: z.enum(['only', 'except']).optional(),
});

export const costSchemas = {
  payRates: z.tuple([id]),
  createPayRate: z.tuple([payRateInput]),
  updatePayRate: z.tuple([
    id,
    payRateInput.pick({ hourlyRate: true, effectiveFrom: true }).partial(),
  ]),
  deletePayRate: z.tuple([id]),
  differentials: z.tuple([id]),
  createDifferential: z.tuple([differentialInput]),
  updateDifferential: z.tuple([
    id,
    differentialInput
      .pick({ kind: true, mode: true, amount: true, active: true })
      .partial()
      // null clears the window or trigger; it is not part of the create shape.
      .extend({
        window: differentialWindow.nullable().optional(),
        consecutive: differentialConsecutive.nullable().optional(),
      }),
  ]),
  deleteDifferential: z.tuple([id]),
  overtimeRules: z.tuple([id]),
  createOvertimeRule: z.tuple([overtimeRuleInput]),
  updateOvertimeRule: z.tuple([
    id,
    overtimeRuleInput
      .pick({ basis: true, thresholdHours: true, multiplier: true, active: true })
      .partial()
      // null clears either back to its default; they are not part of the required create shape.
      .extend({
        pyramiding: z.enum(['stack', 'none']).nullable().optional(),
        minimumMinutes: z.number().int().min(0).max(240).nullable().optional(),
        scheduleKinds: z
          .array(z.enum(['standard', 'va_72_80', 'va_baylor']))
          .min(1)
          .nullable()
          .optional(),
        tourDays: z.enum(['only', 'except']).nullable().optional(),
      }),
  ]),
  deleteOvertimeRule: z.tuple([id]),
  report: z.tuple([id]),
  setBudget: z.tuple([id, money]),
  paySettings: z.tuple([id]),
  savePaySettings: z.tuple([
    id,
    object({ callBackMinimumHours: hours, premiumStacking: z.enum(['compound', 'additive']) }),
  ]),
} satisfies ResourceSchemas<'cost'>;
