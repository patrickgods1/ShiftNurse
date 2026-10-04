/** Argument schemas for `exchange`. */

import { z } from 'zod';
import { id, object, type ResourceSchemas, text } from './primitives.js';

const status = z.enum(['proposed', 'approved', 'denied', 'cancelled']);

// A giveaway carries no requested assignment; whether a trade needs one is the evaluator's call.
const proposal = object({
  kind: z.enum(['trade', 'giveaway']),
  requestingNurseId: id,
  counterpartyNurseId: id,
  offeredAssignmentId: id,
  requestedAssignmentId: id.optional(),
});

export const exchangeSchemas = {
  list: z.tuple([id, status.optional()]),
  listForPeriod: z.tuple([id, status.optional()]),
  evaluate: z.tuple([id, proposal]),
  propose: z.tuple([id, proposal, text.optional()]),
  approve: z.tuple([id, text.optional()]),
  deny: z.tuple([id, text]),
  cancel: z.tuple([id, text.optional()]),
} satisfies ResourceSchemas<'exchange'>;
