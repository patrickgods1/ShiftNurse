import { beforeEach, describe, expect, it } from 'vitest';

import type { PayRate } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { makeNurse, resetFixtureCounters } from '../testing/fixtures.js';
import { resolvePayRate } from './rates.js';

beforeEach(() => {
  resetFixtureCounters();
});

let rateCounter = 0;
function rate(
  scope: { nurseId: string } | { role: PayRate['role'] },
  hourlyRate: number,
  effectiveFrom: string,
): PayRate {
  rateCounter++;
  return {
    id: `rate-${rateCounter}`,
    nurseId: 'nurseId' in scope ? scope.nurseId : null,
    role: 'role' in scope ? scope.role : null,
    hourlyRate,
    effectiveFrom: isoDate(effectiveFrom),
  };
}

describe('resolving the rate in force', () => {
  it("uses the nurse's own negotiated rate over the role default", () => {
    const nurse = makeNurse({ role: 'RN' });
    const rates = [
      rate({ role: 'RN' }, 48, '2025-01-01'),
      rate({ nurseId: nurse.id }, 55, '2025-06-01'),
    ];

    const resolved = resolvePayRate(rates, nurse, isoDate('2026-01-05'));
    expect(resolved?.rate.hourlyRate).toBe(55);
    expect(resolved?.source).toBe('nurse');
  });

  it('falls back to the role default when the nurse has no rate of their own', () => {
    const nurse = makeNurse({ role: 'RN' });
    const rates = [rate({ role: 'RN' }, 48, '2025-01-01')];

    const resolved = resolvePayRate(rates, nurse, isoDate('2026-01-05'));
    expect(resolved?.rate.hourlyRate).toBe(48);
    expect(resolved?.source).toBe('role');
  });

  it('picks the most recent rate in force on the date, not the newest on file', () => {
    const nurse = makeNurse({ role: 'RN' });
    const rates = [rate({ role: 'RN' }, 48, '2025-01-01'), rate({ role: 'RN' }, 50, '2026-01-10')];

    // The raise takes effect on the 10th: the 5th is still at the old rate, the 10th itself
    // and everything after it are at the new one.
    expect(resolvePayRate(rates, nurse, isoDate('2026-01-05'))?.rate.hourlyRate).toBe(48);
    expect(resolvePayRate(rates, nurse, isoDate('2026-01-10'))?.rate.hourlyRate).toBe(50);
    expect(resolvePayRate(rates, nurse, isoDate('2026-01-12'))?.rate.hourlyRate).toBe(50);
  });

  it('has no rate for a date before any rate took effect', () => {
    const nurse = makeNurse({ role: 'RN' });
    const rates = [rate({ role: 'RN' }, 48, '2026-02-01')];

    expect(resolvePayRate(rates, nurse, isoDate('2026-01-05'))).toBeUndefined();
  });

  it("does not price a nurse with another nurse's rate or another role's default", () => {
    const rn = makeNurse({ role: 'RN' });
    const other = makeNurse({ role: 'RN' });
    const rates = [
      rate({ nurseId: other.id }, 70, '2025-01-01'),
      rate({ role: 'LPN' }, 31, '2025-01-01'),
    ];

    expect(resolvePayRate(rates, rn, isoDate('2026-01-05'))).toBeUndefined();
  });

  it('keeps using the role default when the nurse-specific rate has not started yet', () => {
    const nurse = makeNurse({ role: 'RN' });
    const rates = [
      rate({ role: 'RN' }, 48, '2025-01-01'),
      rate({ nurseId: nurse.id }, 60, '2026-03-01'),
    ];

    const resolved = resolvePayRate(rates, nurse, isoDate('2026-01-05'));
    expect(resolved?.rate.hourlyRate).toBe(48);
    expect(resolved?.source).toBe('role');
  });
});
