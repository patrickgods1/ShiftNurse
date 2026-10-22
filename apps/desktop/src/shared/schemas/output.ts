/** Argument schemas for `output`. */

import { z } from 'zod';
import { id, isoDate, type ResourceSchemas, readRange } from './primitives.js';

export const outputSchemas = {
  exportToFile: z.tuple([id, z.enum(['pdf-grid', 'pdf-nurses', 'csv-grid', 'csv-long', 'xlsx'])]),
  exportStaffingRecord: z
    .tuple([id, isoDate, isoDate, z.enum(['csv', 'pdf'])])
    .superRefine(readRange(3660)),
  renderCsv: z.tuple([id, z.enum(['csv-grid', 'csv-long'])]),
} satisfies ResourceSchemas<'output'>;
