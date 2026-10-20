/** Argument schemas for `roster`. */

import type { IsoDate } from '@shiftnurse/core';
import { z } from 'zod';
import { nurseFields } from './nurses.js';
import { id, isoDate, name, object, type ResourceSchemas } from './primitives.js';

/** A previewed CSV row, sent back to be applied: `RosterCsvRow` field for field. */
const rosterRow = object({
  nurse: nurseFields.pick({
    employeeId: true,
    firstName: true,
    lastName: true,
    role: true,
    employmentType: true,
    fte: true,
    contractedHoursPerPeriod: true,
    seniorityDate: true,
    hireDate: true,
    isChargeEligible: true,
    isNovice: true,
    isFloatEligible: true,
    phone: true,
    email: true,
    notes: true,
    scheduleKind: true,
    scheduledDaysPerWeek: true,
  }),
  credentials: z.array(
    object({
      code: name,
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
