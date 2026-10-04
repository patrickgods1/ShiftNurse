/** Argument schemas for `backups`. */

import { z } from 'zod';
import { none, object, type ResourceSchemas } from './primitives.js';

/** Main finds the backup by listing for this name, never by joining it onto a path, so it is
 * only required to be present. */
const fileName = z.string().min(1, 'must be a backup file name');

export const backupsSchemas = {
  list: none,
  create: none,
  restore: z.tuple([fileName]),
  listDeleted: none,
  remove: z.tuple([fileName, object({ permanent: z.boolean().optional() }).optional()]),
  undelete: z.tuple([fileName]),
  purge: z.tuple([fileName]),
} satisfies ResourceSchemas<'backups'>;
