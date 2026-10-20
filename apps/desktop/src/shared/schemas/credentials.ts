/** Argument schemas for `credentials`. */

import { z } from 'zod';
import { id, isoDate, name, none, object, type ResourceSchemas, text } from './primitives.js';

const credentialInput = object({
  code: name,
  name,
  tracksExpiry: z.boolean(),
});

const nurseCredentialInput = object({
  nurseId: id,
  credentialId: id,
  issuedOn: isoDate.optional(),
  expiresOn: isoDate.optional(),
});

const newCredentialGrant = object({
  nurseId: id,
  code: name,
  name,
  tracksExpiry: z.boolean(),
  expiresOn: isoDate.optional(),
});

export const credentialsSchemas = {
  list: none,
  create: z.tuple([credentialInput]),
  forNurse: z.tuple([id]),
  grant: z.tuple([nurseCredentialInput]),
  grantNew: z.tuple([newCredentialGrant]),
  updateExpiry: z.tuple([id, isoDate.or(z.undefined())]),
  revoke: z.tuple([id, text.optional()]),
} satisfies ResourceSchemas<'credentials'>;
