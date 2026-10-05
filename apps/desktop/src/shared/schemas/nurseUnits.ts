/** Argument schemas for `nurseUnits`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const nurseUnitInput = object({
  nurseId: id,
  unitId: id,
  competency: text.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});

/** The nurse and the unit never change; a field is cleared with `null`. */
const nurseUnitPatch = object({
  competency: text.nullable(),
  startDate: isoDate.nullable(),
  endDate: isoDate.nullable(),
}).partial();

export const nurseUnitsSchemas = {
  forNurse: z.tuple([id]),
  floatingIn: z.tuple([id]),
  roster: z.tuple([id]),
  create: z.tuple([nurseUnitInput]),
  update: z.tuple([id, nurseUnitPatch]),
  remove: z.tuple([id]),
} satisfies ResourceSchemas<'nurseUnits'>;
