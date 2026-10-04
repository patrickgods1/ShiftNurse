/** Argument schemas for `coverage`. */

import { z } from 'zod';
import { count, id, isoDate, nurseRole, object, type ResourceSchemas } from './primitives.js';

/** Sunday = 0, as core's `Weekday` and `weekdayOf` number them. */
const weekday = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

const coverageInput = object({
  id: id.optional(),
  unitId: id,
  shiftTypeId: id,
  weekday: weekday.nullable(),
  date: isoDate.nullable(),
  role: nurseRole,
  minCount: count,
  targetCount: count,
});

export const coverageSchemas = {
  list: z.tuple([id]),
  upsert: z.tuple([coverageInput]),
  delete: z.tuple([id]),
} satisfies ResourceSchemas<'coverage'>;
