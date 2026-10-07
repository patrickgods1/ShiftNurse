/** Argument schemas for `floatOut`. */

import { z } from 'zod';
import { id, isoDate, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

const orderRequest = object({
  periodId: id,
  date: isoDate,
  shiftTypeId: id,
  role: nurseRole,
  volunteers: z.array(id),
});

// A blank objection or unit name is refused by the repository in words, which reach the manager.
const sendInput = object({
  periodId: id,
  date: isoDate,
  shiftTypeId: id,
  role: nurseRole,
  volunteers: z.array(id),
  nurseId: id,
  toUnit: text,
  objection: text.optional(),
  reason: text,
});

export const floatOutSchemas = {
  order: z.tuple([orderRequest]),
  send: z.tuple([sendInput]),
  history: z.tuple([id, isoDate]),
  recordObjection: z.tuple([id, text]),
} satisfies ResourceSchemas<'floatOut'>;
