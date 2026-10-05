/** Argument schemas for `acuity`. */

import { z } from 'zod';
import { id, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

const tierInput = object({
  unitId: id,
  name: text,
  level: z.number().int(),
  careHoursPerPatientDay: z.number().gt(0, 'must be more than zero'),
});

/** A ratio counts one role, or `licensed`: RNs and LPN/LVNs together (Title 22). */
const ratioRole = z.union([nurseRole, z.literal('licensed')]);
const rnShare = z.number().gt(0, 'must be more than 0%').max(1, 'must be at most 100%');

const ratioRuleInput = object({
  unitId: id,
  role: ratioRole,
  acuityTierId: id.nullable(),
  maxPatientsPerNurse: z.number().gt(0, 'must be more than zero'),
  citation: text.optional(),
  minRnShare: rnShare.optional(),
  active: z.boolean(),
});

export const acuitySchemas = {
  tiers: z.tuple([id]),
  createTier: z.tuple([tierInput]),
  updateTier: z.tuple([id, tierInput.omit({ unitId: true }).partial()]),
  deleteTier: z.tuple([id]),
  ratioRules: z.tuple([id]),
  createRatioRule: z.tuple([ratioRuleInput]),
  // A patch clears a citation with null; a create just leaves it out.
  updateRatioRule: z.tuple([
    id,
    ratioRuleInput
      .omit({ unitId: true, citation: true, minRnShare: true })
      .partial()
      .extend({ citation: text.nullable().optional(), minRnShare: rnShare.nullable().optional() }),
  ]),
  deactivateRatioRule: z.tuple([id]),
  hppd: z.tuple([id]),
  setHppd: z.tuple([id, z.number().gt(0, 'must be more than zero')]),
} satisfies ResourceSchemas<'acuity'>;
