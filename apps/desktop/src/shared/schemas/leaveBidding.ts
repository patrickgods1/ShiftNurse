/** Argument schemas for `leaveBidding`. */

import { z } from 'zod';
import { count, id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

/** Places off a day per role. Whole numbers: a place is a person. */
const offPerDay = object({
  RN: count.optional(),
  LPN: count.optional(),
  CNA: count.optional(),
});

const maxAwards = z.number().int('must be a whole number').min(1, 'must be 1 or more');

const roundInput = object({
  unitId: id,
  name: text,
  coversStart: isoDate,
  coversEnd: isoDate,
  opensOn: isoDate,
  closesOn: isoDate,
  offPerDay,
  maxAwardsPerNurse: maxAwards.optional(),
});

/** The unit never changes, and a limit takes `null` to be removed. */
const roundPatch = object({
  name: text,
  coversStart: isoDate,
  coversEnd: isoDate,
  opensOn: isoDate,
  closesOn: isoDate,
  offPerDay,
  maxAwardsPerNurse: maxAwards.nullable(),
}).partial();

const choice = object({
  rank: z.number().int('must be a whole number').min(1, 'must be 1 or more'),
  startDate: isoDate,
  endDate: isoDate,
});

export const leaveBiddingSchemas = {
  rounds: z.tuple([id]),
  createRound: z.tuple([roundInput]),
  updateRound: z.tuple([id, roundPatch]),
  closeRound: z.tuple([id]),
  bids: z.tuple([id]),
  submitBid: z.tuple([id, id, z.array(choice)]),
  award: z.tuple([id]),
} satisfies ResourceSchemas<'leaveBidding'>;
