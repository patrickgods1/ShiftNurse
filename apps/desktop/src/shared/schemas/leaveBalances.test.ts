import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from './index.js';

describe('leave balances arriving over IPC', () => {
  const s = API_SCHEMAS.leaveBalances;

  it('accepts a payroll balance and refuses a negative one or an unkept type', () => {
    expect(s.setBalance.safeParse(['n-1', 'pto', 40, '2026-10-01']).success).toBe(true);
    expect(s.setBalance.safeParse(['n-1', 'pto', -4, '2026-10-01']).success).toBe(false);
    expect(s.setBalance.safeParse(['n-1', 'fmla', 40, '2026-10-01']).success).toBe(false);
  });

  it('accepts a certification, and an edit that clears the note with null', () => {
    const cert = {
      nurseId: 'n-1',
      startDate: '2026-10-01',
      endDate: '2027-03-31',
      intermittent: true,
    };
    expect(s.addCertification.safeParse([cert]).success).toBe(true);
    expect(s.updateCertification.safeParse(['c-1', { note: null }]).success).toBe(true);
  });

  it('refuses an edit that tries to hand a certification to another nurse', () => {
    expect(s.updateCertification.safeParse(['c-1', { nurseId: 'n-2' }]).success).toBe(false);
  });

  it('accepts a comp-time election, and an edit that reopens the end and clears the note', () => {
    const election = { unitId: 'u-1', nurseId: 'n-1', startsOn: '2026-10-01' };
    expect(s.addCompElection.safeParse([election]).success).toBe(true);
    expect(s.addCompElection.safeParse([{ ...election, endsOn: '2027-03-31' }]).success).toBe(true);
    expect(s.updateCompElection.safeParse(['c-1', { endsOn: null, note: null }]).success).toBe(
      true,
    );
  });

  it('refuses a comp-time election with a key it does not know, or an edit that moves the nurse', () => {
    const election = { unitId: 'u-1', nurseId: 'n-1', startsOn: '2026-10-01' };
    expect(s.addCompElection.safeParse([{ ...election, enteredBy: 'nurse' }]).success).toBe(false);
    expect(s.addCompElection.safeParse([{ nurseId: 'n-1', startsOn: '2026-10-01' }]).success).toBe(
      false,
    );
    expect(s.updateCompElection.safeParse(['c-1', { nurseId: 'n-2' }]).success).toBe(false);
  });
});
