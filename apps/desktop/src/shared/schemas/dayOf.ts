/** Argument schemas for `dayOf`. */

import { z } from 'zod';
import { hours, id, isoDate, type ResourceSchemas, text } from './primitives.js';

// `accepted` is deliberately absent: an accepted call goes through `backfill`.
const unansweredOutcome = z.enum(['declined', 'no_answer', 'left_message', 'ineligible']);

export const dayOfSchemas = {
  today: z.tuple([id, isoDate.optional()]),
  callOffs: z.tuple([id, isoDate, isoDate]),
  reportCallOff: z.tuple([id, text.optional(), hours.optional()]),
  replacements: z.tuple([id]),
  logCall: z.tuple([id, id, unansweredOutcome, text.optional()]),
  backfill: z.tuple([id, id, text.optional()]),
  markUncovered: z.tuple([id, text]),
  cancelCallOff: z.tuple([id, text]),
  callLog: z.tuple([id]),
} satisfies ResourceSchemas<'dayOf'>;
