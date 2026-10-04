/** Argument schemas for `credentials`. */

import { z } from 'zod';
import { id, isoDate, none, object, type ResourceSchemas, text } from './primitives.js';

const credentialInput = object({
  code: text,
  name: text,
  tracksExpiry: z.boolean(),
});

const nurseCredentialInput = object({
  nurseId: id,
  credentialId: id,
  issuedOn: isoDate.optional(),
  expiresOn: isoDate.optional(),
});

export const credentialsSchemas = {
  list: none,
  create: z.tuple([credentialInput]),
  forNurse: z.tuple([id]),
  grant: z.tuple([nurseCredentialInput]),
  updateExpiry: z.tuple([id, isoDate.or(z.undefined())]),
  revoke: z.tuple([id]),
} satisfies ResourceSchemas<'credentials'>;
