import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('a credential arriving over IPC', () => {
  it('accepts a grant with no expiry, meaning it never lapses', () => {
    const ok = API_SCHEMAS.credentials.grant.safeParse([{ nurseId: 'n-1', credentialId: 'c-1' }]);
    expect(ok.success).toBe(true);
  });

  it('accepts clearing an expiry and refuses a date that does not exist', () => {
    const update = API_SCHEMAS.credentials.updateExpiry;
    expect(update.safeParse(['nc-1', undefined]).success).toBe(true);
    expect(update.safeParse(['nc-1', '2026-02-30']).success).toBe(false);
  });

  it('refuses a catalogue entry with a stray field', () => {
    const create = API_SCHEMAS.credentials.create;
    expect(create.safeParse([{ code: 'ACLS', name: 'ACLS', tracksExpiry: true }]).success).toBe(
      true,
    );
    expect(
      create.safeParse([{ code: 'ACLS', name: 'ACLS', tracksExpiry: true, id: 'x' }]).success,
    ).toBe(false);
  });

  it('accepts a new type with its first grant, and refuses a stray field', () => {
    const grantNew = API_SCHEMAS.credentials.grantNew;
    const input = {
      nurseId: 'n-1',
      code: 'TNCC',
      name: 'Trauma Nursing Core Course',
      tracksExpiry: true,
      expiresOn: '2027-05-01',
    };
    expect(grantNew.safeParse([input]).success).toBe(true);
    expect(grantNew.safeParse([{ ...input, issuedOn: '2026-01-01' }]).success).toBe(false);
  });

  it('accepts a revoke with or without a reason', () => {
    const revoke = API_SCHEMAS.credentials.revoke;
    expect(revoke.safeParse(['nc-1']).success).toBe(true);
    expect(revoke.safeParse(['nc-1', 'why']).success).toBe(true);
  });
});
