/** Argument schemas for `availabilityBlocks`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text, timeOfDay } from './primitives.js';

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

// Distinct, non-empty days are the repository's call, which words the refusal; a blank reason too.
const blockInput = object({
  unitId: id,
  nurseId: id,
  weekdays: z.array(weekday),
  startTime: timeOfDay,
  endTime: timeOfDay,
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  reason: text,
});

/** The unit and nurse never change, and a date takes `null` to clear it. */
const blockPatch = object({
  weekdays: z.array(weekday),
  startTime: timeOfDay,
  endTime: timeOfDay,
  startsOn: isoDate.nullable(),
  endsOn: isoDate.nullable(),
}).partial();

export const availabilityBlocksSchemas = {
  list: z.tuple([id]),
  create: z.tuple([blockInput]),
  update: z.tuple([id, blockPatch, text]),
  remove: z.tuple([id, text]),
} satisfies ResourceSchemas<'availabilityBlocks'>;
