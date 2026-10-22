/** Argument schemas for `dayOfPay`. */

import { z } from 'zod';
import {
  hours,
  id,
  isoDate,
  object,
  type ResourceSchemas,
  readRange,
  shiftHours,
  text,
} from './primitives.js';

const where = {
  unitId: id,
  nurseId: id,
  date: isoDate,
  shiftTypeId: id.optional(),
  note: text.optional(),
};

const entry = z.discriminatedUnion('kind', [
  object({ kind: z.literal('missed_break'), ...where, break: z.enum(['meal', 'rest']) }),
  object({
    kind: z.literal('sent_home'),
    ...where,
    scheduledHours: shiftHours,
    hoursWorked: hours.optional(),
  }),
  object({
    kind: z.literal('call_back'),
    ...where,
    hoursWorked: hours,
    // Minutes from the start of the standby shift; the repository checks it against that shift.
    startMinute: z.number().int().min(0),
  }),
]);

/** Only the hours, the start and the note can change; the nurse, the day and the kind are what happened. */
const patch = object({
  hoursWorked: hours,
  startMinute: z.number().int().min(0),
  note: text.nullable(),
}).partial();

export const dayOfPaySchemas = {
  list: z.tuple([id, isoDate, isoDate]).superRefine(readRange(400)),
  record: z.tuple([entry]),
  update: z.tuple([id, patch]),
  remove: z.tuple([id]),
} satisfies ResourceSchemas<'dayOfPay'>;
