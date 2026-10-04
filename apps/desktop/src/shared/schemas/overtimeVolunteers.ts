/** Argument schemas for `overtimeVolunteers`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const volunteerInput = object({
  unitId: id,
  nurseId: id,
  startDate: isoDate,
  endDate: isoDate,
  note: text.optional(),
});

/** The unit and nurse never change, and the note takes `null` to clear it. */
const volunteerPatch = object({
  startDate: isoDate,
  endDate: isoDate,
  note: text.nullable(),
}).partial();

export const overtimeVolunteersSchemas = {
  list: z.tuple([id]),
  create: z.tuple([volunteerInput]),
  update: z.tuple([id, volunteerPatch]),
  remove: z.tuple([id]),
} satisfies ResourceSchemas<'overtimeVolunteers'>;
