/** Argument schemas for `output`. */

import { z } from 'zod';
import { id, type ResourceSchemas } from './primitives.js';

export const outputSchemas = {
  exportToFile: z.tuple([id, z.enum(['pdf-grid', 'pdf-nurses', 'csv-grid', 'csv-long', 'xlsx'])]),
  renderCsv: z.tuple([id, z.enum(['csv-grid', 'csv-long'])]),
} satisfies ResourceSchemas<'output'>;
