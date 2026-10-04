/** Argument schemas for `publish`. */

import { z } from 'zod';
import { id, type ResourceSchemas, text } from './primitives.js';

export const publishSchemas = {
  preview: z.tuple([id]),
  publish: z.tuple([id, text.optional()]),
  versions: z.tuple([id]),
  changes: z.tuple([id]),
  alerts: z.tuple([id]),
} satisfies ResourceSchemas<'publish'>;
