/**
 * Which hard breaches the solver's gate lets a nurse keep. The locked shifts a manager pinned may
 * already break a rule; the gate must keep that nurse schedulable without ever letting Generate
 * grow the breach, rename it onto a shift it placed, or swap it for a different one.
 */

import { describe, expect, it } from 'vitest';
import type { Id } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import { consecutiveShiftsRule } from '../rules/rest-rules.js';
import { type Violation, violation } from '../rules/types.js';
import { breachAllowance, isTolerated } from './gate.js';

const LOCKED = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'];

function breach(
  amount: number,
  assignmentIds: Id[],
  code:
    | 'too_many_consecutive_shifts'
    | 'too_many_consecutive_nights' = 'too_many_consecutive_shifts',
): Violation {
  return violation(consecutiveShiftsRule, 'hard', code, 'Ada works too many days in a row', {
    amount,
    nurseIds: ['ada'],
    dates: DATES.map(isoDate),
    assignmentIds,
  });
}

describe('which breaches a locked shift may keep', () => {
  const allowance = breachAllowance([breach(6, LOCKED)]);
  const pinned = new Set(LOCKED);

  it('keeps a breach the locked shifts already had, exactly as big', () => {
    expect(isTolerated(breach(6, LOCKED), allowance, pinned)).toBe(true);
  });

  it('refuses the same breach grown by a day', () => {
    expect(isTolerated(breach(7, LOCKED), allowance, pinned)).toBe(false);
  });

  it('refuses a breach that names a shift Generate placed', () => {
    expect(isTolerated(breach(6, [...LOCKED.slice(0, 5), 'sol-1']), allowance, pinned)).toBe(false);
  });

  it('refuses a breach the locked shifts did not have', () => {
    expect(isTolerated(breach(6, LOCKED, 'too_many_consecutive_nights'), allowance, pinned)).toBe(
      false,
    );
  });

  it('keeps a matching breach that names no shift at all', () => {
    expect(isTolerated(breach(6, []), allowance, pinned)).toBe(true);
    expect(isTolerated(breach(6, []), breachAllowance([]), pinned)).toBe(false);
  });

  it('refuses a breach that names no shift once it grows past what the locks had', () => {
    expect(isTolerated(breach(7, []), allowance, pinned)).toBe(false);
  });

  it('measures against the largest of two locked breaches under the same name', () => {
    const two = breachAllowance([breach(2, LOCKED), breach(6, LOCKED)]);
    expect(isTolerated(breach(6, LOCKED), two, pinned)).toBe(true);
    expect(isTolerated(breach(7, LOCKED), two, pinned)).toBe(false);
  });
});
