/** Argument schemas for `dayOf`. */

import { z } from 'zod';
import { hours, id, isoDate, nurseRole, type ResourceSchemas, text } from './primitives.js';

// `accepted` is deliberately absent: an accepted call goes through `backfill`.
const cancellationTiers = z.array(
  z.enum(['volunteer', 'agency', 'overtime', 'per_diem', 'rotation']),
);

const unansweredOutcome = z.enum(['declined', 'no_answer', 'left_message', 'ineligible']);

// The repository re-checks the range and the reason; this keeps junk off the bridge.
const holdoverInput = z.object({
  assignmentId: id,
  minutes: z.number().int().min(0).max(720),
  mandated: z.boolean(),
  reason: text.optional(),
});

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
  cancellationPolicy: z.tuple([id]),
  saveCancellationPolicy: z.tuple([id, cancellationTiers]),
  cancellationOrder: z.tuple([id, isoDate, id, nurseRole, z.array(id)]),
  cancelForCensus: z.tuple([id, isoDate, id, nurseRole, z.array(id), id]),
  recordHoldover: z.tuple([holdoverInput]),
} satisfies ResourceSchemas<'dayOf'>;
