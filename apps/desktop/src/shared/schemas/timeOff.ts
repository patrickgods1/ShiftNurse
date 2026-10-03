/** Argument schemas for `timeOff`. */

import { z } from 'zod';
import { hours, id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const timeOffType = z.enum(['pto', 'sick', 'unpaid', 'fmla', 'education', 'bereavement']);
const timeOffStatus = z.enum(['pending', 'approved', 'denied', 'cancelled']);

// A reason is `text`, never `.min(1)`: the audit layer refuses a blank denial in words for
// the manager, and that wording is what the screen shows.
const createInput = object({
  nurseId: id,
  startDate: isoDate,
  endDate: isoDate,
  type: timeOffType,
  reason: text.optional(),
  paidHours: hours.optional(),
});

const cover = object({ assignmentId: id, nurseId: id });

export const timeOffSchemas = {
  list: z.tuple([id, timeOffStatus.optional()]),
  listInRange: z.tuple([id, isoDate, isoDate]),
  create: z.tuple([createInput]),
  coverOptions: z.tuple([id, id]),
  approveAndCover: z.tuple([id, id, text.optional(), z.array(cover)]),
  approve: z.tuple([id, text.optional()]),
  deny: z.tuple([id, text]),
  cancel: z.tuple([id, text.optional()]),
  withdrawApproval: z.tuple([id, text]),
  impact: z.tuple([id, id, z.enum(['approved', 'denied'])]),
} satisfies ResourceSchemas<'timeOff'>;
