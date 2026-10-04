/** Argument schemas for `dashboard`. */

import { z } from 'zod';
import { id, type ResourceSchemas } from './primitives.js';

export const dashboardSchemas = {
  summary: z.tuple([id]),
} satisfies ResourceSchemas<'dashboard'>;
