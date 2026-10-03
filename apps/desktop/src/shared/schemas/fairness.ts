/** Argument schemas for `fairness`. */

import { z } from 'zod';
import { id, isoDate, object, type ResourceSchemas, text } from './primitives.js';

/** Mirrors core's `HistoricalShiftRow`. */
const historicalShiftRow = object({
  employeeId: text,
  date: isoDate,
  shiftAbbreviation: text,
});

export const fairnessSchemas = {
  report: z.tuple([id]),
  history: z.tuple([id]),
  trend: z.tuple([id]),
  pickHistoryImportFile: z.tuple([id]),
  importHistory: z.tuple([id, z.array(historicalShiftRow)]),
} satisfies ResourceSchemas<'fairness'>;
