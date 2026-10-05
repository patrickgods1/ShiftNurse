/** Argument schemas for `preceptorships`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas } from './primitives.js';

const preceptorshipInput = object({
  unitId: id,
  orienteeId: id,
  preceptorIds: z.array(id).min(1, 'choose at least one preceptor'),
  startDate: isoDate,
  endDate: isoDate,
});

/** The unit and the pair never change, so only the dates are accepted. */
const preceptorshipPatch = object({ startDate: isoDate, endDate: isoDate }).partial();

export const preceptorshipsSchemas = {
  list: z.tuple([id]),
  create: z.tuple([preceptorshipInput]),
  update: z.tuple([id, preceptorshipPatch]),
  remove: z.tuple([id]),
} satisfies ResourceSchemas<'preceptorships'>;
