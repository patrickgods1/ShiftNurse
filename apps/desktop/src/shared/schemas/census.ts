/** Argument schemas for `census`. */

import { z } from 'zod';
import { count, id, isoDate, object, type ResourceSchemas } from './primitives.js';

/** acuityTierId → patients. That the mix sums to the census is the repository's check. */
const acuityMix = z.record(id, z.number().min(0, 'must be zero or more'));

const censusInput = object({
  unitId: id,
  date: isoDate,
  shiftTypeId: id,
  projectedCensus: count,
  acuityMix,
  source: z.enum(['manual', 'forecast']),
});

const forecastOptions = object({
  lookbackWeeks: z.number().min(0).optional(),
  seasonal: z.boolean().optional(),
  seasonalWindowWeeks: z.number().min(0).optional(),
});

export const censusSchemas = {
  list: z.tuple([id, isoDate, isoDate]),
  upsert: z.tuple([censusInput]),
  upsertMany: z.tuple([z.array(censusInput)]),
  recordActual: z.tuple([id, count, acuityMix]),
  delete: z.tuple([id]),
  propose: z.tuple([id, isoDate, isoDate, forecastOptions.optional()]),
  backtest: z.tuple([id, forecastOptions.optional()]),
  demand: z.tuple([id, isoDate, isoDate]),
  hppd: z.tuple([id]),
} satisfies ResourceSchemas<'census'>;
