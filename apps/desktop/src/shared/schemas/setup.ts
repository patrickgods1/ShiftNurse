/** Argument schemas for `setup`. */

import { z } from 'zod';
import {
  count,
  id,
  isoDate,
  money,
  none,
  object,
  postingLeadDays,
  type ResourceSchemas,
  ratioStaffing,
  text,
} from './primitives.js';

// Local copy: this file may not import another resource's schemas.
const unitInput = object({
  name: text,
  unitType: text,
  payPeriodDays: z.number().int('must be a whole number').min(1, 'must be 1 or more'),
  payPeriodAnchor: isoDate,
  ratioStaffing: ratioStaffing.optional(),
  postingLeadDays: postingLeadDays.optional(),
});

const setupStep = z.enum([
  'shift-types',
  'coverage',
  'acuity',
  'holidays',
  'rules',
  'pay',
  'roster',
  'finish',
]);

const preset = z.discriminatedUnion('kind', [
  object({ kind: z.literal('shift-pattern'), pattern: z.enum(['12h', '8h', 'both']) }),
  object({
    kind: z.literal('acuity'),
    preset: z.enum(['med-surg', 'telemetry', 'step-down', 'icu']),
  }),
  object({
    kind: z.literal('coverage'),
    shiftTypeIds: z.array(id),
    counts: object({
      RN: count.optional(),
      LPN: count.optional(),
      CNA: count.optional(),
    }),
  }),
  object({ kind: z.literal('holidays'), years: z.array(z.number().int()) }),
  object({ kind: z.literal('rules') }),
  object({
    kind: z.literal('base-rates'),
    rates: object({
      RN: money.optional(),
      LPN: money.optional(),
      CNA: money.optional(),
    }),
  }),
]);

export const setupSchemas = {
  status: none,
  demos: none,
  loadDemo: z.tuple([id]),
  loadScenarios: none,
  createUnit: z.tuple([unitInput, z.enum(['manual', 'assisted'])]),
  advance: z.tuple([object({ from: setupStep, to: setupStep, skipped: z.boolean() })]),
  complete: none,
  resume: none,
  applyPreset: z.tuple([id, preset]),
  applyJurisdiction: z.tuple([id, z.enum(['CA', 'OR', 'NY', 'WA', 'MA', 'other'])]),
  startOver: none,
} satisfies ResourceSchemas<'setup'>;
