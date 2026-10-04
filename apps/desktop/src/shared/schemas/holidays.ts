/** Argument schemas for `holidays`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const holidayInput = object({
  unitId: id,
  date: isoDate,
  name: text,
  isMajor: z.boolean(),
  pairedHolidayId: id.nullable().optional(),
});

/** The major holiday a minor one pairs with: one already saved, or one in the same plan. */
const pairTarget = z.union([object({ holidayId: id }), object({ key: text })]);

const plannedHoliday = object({
  key: text,
  date: isoDate,
  name: text,
  isMajor: z.boolean(),
  pairWith: pairTarget.nullable(),
});

const holidayYearInput = object({
  holidays: z.array(plannedHoliday),
  repairs: z.array(object({ minorId: id, pairWith: pairTarget })),
});

export const holidaysSchemas = {
  list: z.tuple([id]),
  create: z.tuple([holidayInput]),
  update: z.tuple([
    id,
    holidayInput.pick({ name: true, isMajor: true, pairedHolidayId: true }).partial(),
  ]),
  delete: z.tuple([id]),
  work: z.tuple([id]),
  recordWork: z.tuple([id, z.array(id)]),
  clearWork: z.tuple([id]),
  planYear: z.tuple([id, z.number().int()]),
  addYear: z.tuple([id, holidayYearInput]),
} satisfies ResourceSchemas<'holidays'>;
