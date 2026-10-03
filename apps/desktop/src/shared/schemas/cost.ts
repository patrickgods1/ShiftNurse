/** Argument schemas for `cost` — the reference pattern for every resource's schemas. */

import { z } from 'zod';
import {
  id,
  isoDate,
  money,
  multiplier,
  nurseRole,
  object,
  type ResourceSchemas,
} from './primitives.js';

const differentialKind = z.enum([
  'night',
  'weekend',
  'holiday',
  'major_holiday',
  'charge',
  'on_call',
  'call_back',
  'agency',
]);
const differentialMode = z.enum(['multiplier', 'flat']);
const overtimeBasis = z.enum(['daily', 'weekly', 'pay_period']);

/** A rate belongs to one nurse or to a role's default — the repository refuses both or neither. */
const payRateInput = object({
  nurseId: id.nullable(),
  role: nurseRole.nullable(),
  hourlyRate: money,
  effectiveFrom: isoDate,
});

const differentialInput = object({
  unitId: id,
  kind: differentialKind,
  mode: differentialMode,
  amount: money,
  active: z.boolean(),
});

const overtimeRuleInput = object({
  unitId: id,
  basis: overtimeBasis,
  // A daily threshold is a few hours, a pay-period one up to 80 or more: any positive number.
  thresholdHours: z.number().gt(0, 'must be more than zero'),
  multiplier,
  active: z.boolean(),
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
    differentialInput.pick({ kind: true, mode: true, amount: true, active: true }).partial(),
  ]),
  deleteDifferential: z.tuple([id]),
  overtimeRules: z.tuple([id]),
  createOvertimeRule: z.tuple([overtimeRuleInput]),
  updateOvertimeRule: z.tuple([
    id,
    overtimeRuleInput
      .pick({ basis: true, thresholdHours: true, multiplier: true, active: true })
      .partial(),
  ]),
  deleteOvertimeRule: z.tuple([id]),
  report: z.tuple([id]),
  setBudget: z.tuple([id, money]),
} satisfies ResourceSchemas<'cost'>;
