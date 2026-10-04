/** Argument schemas for `units`. */

import { z } from 'zod';
import {
  id,
  isoDate,
  object,
  postingLeadDays,
  type ResourceSchemas,
  ratioStaffing,
  text,
} from './primitives.js';

/** A unit's name, type and pay calendar. */
export const unitInput = object({
  name: text,
  unitType: text,
  payPeriodDays: z.number().int('must be a whole number').min(1, 'must be 1 or more'),
  payPeriodAnchor: isoDate,
  ratioStaffing: ratioStaffing.optional(),
  postingLeadDays: postingLeadDays.optional(),
});

export const unitsSchemas = {
  list: z.tuple([]),
  // The pay-period calendar is fixed once hours have been counted, so a patch is name, type and how ratios are kept.
  update: z.tuple([
    id,
    unitInput
      .pick({ name: true, unitType: true, ratioStaffing: true })
      .extend({ postingLeadDays: postingLeadDays.nullable().optional() })
      .partial(),
  ]),
} satisfies ResourceSchemas<'units'>;
