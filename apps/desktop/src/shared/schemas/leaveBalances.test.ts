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
});
