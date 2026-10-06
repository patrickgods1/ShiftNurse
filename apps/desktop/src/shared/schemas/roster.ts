/** Argument schemas for `roster`. */

import type { IsoDate } from '@shiftnurse/core';
import { z } from 'zod';
import { hours, id, isoDate, nurseRole, object, type ResourceSchemas, text } from './primitives.js';

/** A previewed CSV row, sent back to be applied: `RosterCsvRow` field for field. */
const rosterRow = object({
  nurse: object({
    employeeId: text,
    firstName: text,
    lastName: text,
    role: nurseRole,
    employmentType: z.enum(['full_time', 'part_time', 'per_diem', 'agency']),
    fte: hours,
    contractedHoursPerPeriod: hours,
    seniorityDate: isoDate,
    hireDate: isoDate.optional(),
    isChargeEligible: z.boolean(),
    isNovice: z.boolean(),
    isFloatEligible: z.boolean(),
    phone: text.optional(),
    email: text.optional(),
    notes: text.optional(),
  }),
  credentials: z.array(
    object({
      code: text,
      // The type says a required key that may be undefined; typed as a plain schema so the
      // output keeps that shape, while a payload that omits the key still means "never expires".
      expiresOn: isoDate.optional() as z.ZodType<IsoDate | undefined>,
    }),
  ),
});

export const rosterSchemas = {
  pickImportFile: z.tuple([id]),
  importRows: z.tuple([id, z.array(rosterRow)]),
  exportToFile: z.tuple([id]),
  exportCsv: z.tuple([id]),
} satisfies ResourceSchemas<'roster'>;
