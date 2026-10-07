/** Argument schemas for `leaveBalances`. */

import { z } from 'zod';
import { hours, id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

const balanceType = z.enum(['pto', 'annual', 'sick', 'comp']);
const requestType = z.enum([
  'pto',
  'sick',
  'unpaid',
  'fmla',
  'education',
  'bereavement',
  'annual',
  'court',
  'military',
  'parental',
  'lwop',
  'comp',
  'state_family',
  'pregnancy_disability',
]);

const certificationInput = object({
  nurseId: id,
  startDate: isoDate,
  endDate: isoDate,
  intermittent: z.boolean(),
  note: text.optional(),
});

/** The nurse never changes, and the note takes `null` to clear it. */
const certificationPatch = object({
  startDate: isoDate,
  endDate: isoDate,
  intermittent: z.boolean(),
  note: text.nullable(),
}).partial();

export const leaveBalancesSchemas = {
  forNurse: z.tuple([id]),
  setBalance: z.tuple([id, balanceType, hours, isoDate]),
  addCertification: z.tuple([certificationInput]),
  updateCertification: z.tuple([id, certificationPatch]),
  removeCertification: z.tuple([id]),
  checkRequest: z.tuple([id, requestType, isoDate, isoDate, hours]),
} satisfies ResourceSchemas<'leaveBalances'>;
