/** Argument schemas for `shiftTypes`. */

import { z } from 'zod';
import {
  id,
  name,
  object,
  type ResourceSchemas,
  shiftHours,
  text,
  timeOfDay,
} from './primitives.js';

/** Containment is the repository's call (its hours must hold the inside shift): shape only. */
const shiftTypeInput = object({
  unitId: id,
  name,
  abbreviation: name,
  startTime: timeOfDay,
  durationHours: shiftHours,
  isNight: z.boolean(),
  isOnCall: z.boolean(),
  color: text,
  sortOrder: z.number(),
  active: z.boolean(),
  withinShiftTypeId: id.nullable().optional(),
});

export const shiftTypesSchemas = {
  list: z.tuple([id]),
  lockedIds: z.tuple([id]),
  create: z.tuple([shiftTypeInput]),
  update: z.tuple([id, shiftTypeInput.omit({ unitId: true }).partial()]),
  deactivate: z.tuple([id]),
  duplicate: z.tuple([id, shiftTypeInput.omit({ unitId: true, active: true }).partial()]),
} satisfies ResourceSchemas<'shiftTypes'>;
