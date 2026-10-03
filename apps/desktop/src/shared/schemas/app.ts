/** Argument schemas for `app`. */

import { none, type ResourceSchemas } from './primitives.js';

export const appSchemas = {
  info: none,
  update: none,
  openLogs: none,
} satisfies ResourceSchemas<'app'>;
