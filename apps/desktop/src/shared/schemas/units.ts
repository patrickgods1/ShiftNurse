/** Argument schemas for `units`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

/** A unit's name, type and pay calendar. */
export const unitInput = object({
  name: text,
  unitType: text,
  payPeriodDays: z.number().int('must be a whole number').min(1, 'must be 1 or more'),
  payPeriodAnchor: isoDate,
});

export const unitsSchemas = {
  list: z.tuple([]),
  // The pay-period calendar is fixed once hours have been counted, so a patch is name and type.
  update: z.tuple([id, unitInput.pick({ name: true, unitType: true }).partial()]),
} satisfies ResourceSchemas<'units'>;
