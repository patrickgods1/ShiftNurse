/** Argument schemas for `periods`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

export const periodsSchemas = {
  list: z.tuple([id]),
  assignments: z.tuple([id]),
  create: z.tuple([
    object({
      unitId: id,
      name: text,
      startDate: isoDate,
      endDate: isoDate,
      requestsCloseOn: isoDate.optional(),
    }),
  ]),
  setRequestsCloseOn: z.tuple([id, isoDate.nullable()]),
} satisfies ResourceSchemas<'periods'>;
