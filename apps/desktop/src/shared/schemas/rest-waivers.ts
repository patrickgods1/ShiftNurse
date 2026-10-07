/** Argument schemas for `restWaivers`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

// A blank reason is refused by the repository in words, which reach the manager verbatim.
const restWaiverInput = object({ unitId: id, nurseId: id, date: isoDate, reason: text });

export const restWaiversSchemas = {
  list: z.tuple([id]),
  create: z.tuple([restWaiverInput]),
  remove: z.tuple([id, text]),
} satisfies ResourceSchemas<'restWaivers'>;
