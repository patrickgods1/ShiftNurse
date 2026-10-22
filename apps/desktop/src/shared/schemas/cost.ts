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
  text,
  timeOfDay,
} from './primitives.js';

const differentialKind = z.enum([
  'night',
  'evening',
  'weekend',
  'holiday',
  'major_holiday',
  'consecutive_shift',
  'short_rest',
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

const wholeAtLeastOne = z.number().int('must be a whole number').min(1, 'must be at least 1');

/**
 * A consecutive-shift premium's trigger (`Differential.consecutive`): both numbers or none, whole
 * shifts and days, and up to three tiers by shift length (2025–2030 § G.3); the repository refuses
 * it on other kinds, and two tiers of the same length.
 */
const differentialConsecutive = object({
  afterShifts: wholeAtLeastOne,
  withinDays: wholeAtLeastOne,
  tiers: z
    .array(
      object({
        fullShiftHours: wholeAtLeastOne,
        afterShifts: wholeAtLeastOne,
        withinDays: wholeAtLeastOne,
      }),
    )
    .min(1, 'needs at least one tier')
    .max(3, 'has at most three tiers')
    .optional(),
});

/** A short-rest premium's trigger (`Differential.shortRest`); the repository refuses it elsewhere. */
const differentialShortRest = object({
  minHoursOff: z.number().positive('must be more than 0').max(24, 'must be at most 24'),
  scope: z.enum(['whole_shift', 'within_window']),
});

const differentialInput = object({
  unitId: id,
  kind: differentialKind,
  mode: differentialMode,
  amount: money,
  active: z.boolean(),
  window: differentialWindow.optional(),
  consecutive: differentialConsecutive.optional(),
  shortRest: differentialShortRest.optional(),
});

/**
 * A multiplier below 1 prices a negative line (`base * (amount - 1)`), so a cleared 1.5x premium
 * would take a shift's base pay away. On-call standby is paid instead of base at `base * amount`,
 * so its 0.15 is real. Judged only when the payload says kind, mode and amount; an update that
 * leaves one out is judged by the repository against the stored row.
 */
function multiplierAtLeastOne(
  value: { kind?: string | undefined; mode?: string | undefined; amount?: number | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === undefined || value.kind === 'on_call') return;
  if (value.mode !== 'multiplier' || value.amount === undefined || value.amount >= 1) return;
  ctx.addIssue({ code: 'custom', path: ['amount'], message: 'must be 1 or more for a multiplier' });
}

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
  // `differentialInput` stays a plain object because the update below picks from it.
  createDifferential: z.tuple([differentialInput.superRefine(multiplierAtLeastOne)]),
  updateDifferential: z.tuple([
    id,
    differentialInput
      .pick({ kind: true, mode: true, amount: true, active: true })
      .partial()
      // null clears the window or trigger; it is not part of the create shape.
      .extend({
        window: differentialWindow.nullable().optional(),
        consecutive: differentialConsecutive.nullable().optional(),
        shortRest: differentialShortRest.nullable().optional(),
      })
      .superRefine(multiplierAtLeastOne),
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
  clearBudget: z.tuple([id]),
  paySettings: z.tuple([id]),
  savePaySettings: z.tuple([
    id,
    object({
      callBackMinimumHours: hours,
      premiumStacking: z.enum(['compound', 'additive']),
      holidayPayCoversOvertime: z.boolean(),
      // Required: the renderer always sends the whole PaySettings, so a missing one is a bug.
      reportingPayNoticeHours: z.number().min(0).max(24),
      overtimeWindowAttribution: z.enum(['clock', 'start']),
      paySpringForwardAsScheduled: z.boolean(),
      breakPremiumRate: z.enum(['base', 'regular']),
      compTime: z
        .object({
          hoursPerOvertimeHour: z.number().min(1),
          capHours: z.number().positive().nullable(),
        })
        .nullable(),
    }),
  ]),
  reprice: z.tuple([id, text]),
  bankCompTime: z.tuple([id]),
} satisfies ResourceSchemas<'cost'>;
