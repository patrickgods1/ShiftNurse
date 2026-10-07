/** Argument schemas for `preferences`. */

import { z } from 'zod';
import { count, id, object, type ResourceSchemas } from './primitives.js';

/** The nurse's own strength of feeling, 1 to 5. */
const weight = z.number().min(1, 'must be 1 or more').max(5, 'must be 5 or fewer');

const weekday = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

const preferenceInput = z.discriminatedUnion('kind', [
  object({
    kind: z.enum(['prefer_shift_type', 'avoid_shift_type']),
    shiftTypeId: id,
    weight,
  }),
  object({ kind: z.enum(['prefer_weekday', 'avoid_weekday']), weekday, weight }),
  object({
    kind: z.literal('weekend_appetite'),
    level: z.number().min(-1, 'must be -1 or more').max(1, 'must be 1 or fewer'),
    weight,
  }),
  object({ kind: z.literal('preferred_block_length'), shifts: count, weight }),
  object({ kind: z.literal('holiday_appetite'), holidayId: id, weight }),
]);

export const preferencesSchemas = {
  forNurse: z.tuple([id]),
  replace: z.tuple([id, z.array(preferenceInput)]),
} satisfies ResourceSchemas<'preferences'>;
