/** Argument schemas for `incompatibility`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const groupInput = object({
  unitId: id,
  name: text,
  nurseIds: z.array(id),
  maxTogether: z.number().int('must be a whole number').min(1, 'must be 1 or more'),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
});

/** The unit never changes, and a date takes `null` to clear it. */
const groupPatch = object({
  name: text,
  nurseIds: z.array(id),
  maxTogether: groupInput.shape.maxTogether,
  startsOn: isoDate.nullable(),
  endsOn: isoDate.nullable(),
}).partial();

export const incompatibilitySchemas = {
  list: z.tuple([id]),
  create: z.tuple([groupInput, text]),
  update: z.tuple([id, groupPatch, text]),
  remove: z.tuple([id, text]),
} satisfies ResourceSchemas<'incompatibility'>;
