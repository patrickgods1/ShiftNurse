/** Argument schemas for `acuity`. */

import { z } from 'zod';
import { id, name, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

const tierInput = object({
  unitId: id,
  name,
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
  maxPatientsPerNurse: z.number().min(0.5, 'must be 0.5 or more').max(50, 'must be 50 or fewer'),
  citation: text.optional(),
  minRnShare: rnShare.optional(),
  tour: z.enum(['day', 'evening', 'night']).optional(),
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
      .omit({ unitId: true, citation: true, minRnShare: true, tour: true })
      .partial()
      .extend({
        citation: text.nullable().optional(),
        minRnShare: rnShare.nullable().optional(),
        tour: z.enum(['day', 'evening', 'night']).nullable().optional(),
      }),
    text.optional(),
  ]),
  // A blank reason is refused by the repository, which can name the rule.
  deactivateRatioRule: z.tuple([id, text]),
  hppd: z.tuple([id]),
  setHppd: z.tuple([id, z.number().gt(0, 'must be more than zero')]),
} satisfies ResourceSchemas<'acuity'>;
