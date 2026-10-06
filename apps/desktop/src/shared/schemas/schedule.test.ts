import { describe, expect, it } from 'vitest';
import { scheduleSchemas } from './schedule.js';

describe('a hand edit arriving over IPC', () => {
  const update = scheduleSchemas.updateAssignment;

  it('accepts a charge flag with a reason', () => {
    expect(update.safeParse(['a-1', { isCharge: true }, 'covering for Sam']).success).toBe(true);
    expect(update.safeParse(['a-1', { notes: 'swap ok' }, undefined]).success).toBe(true);
  });

  it('refuses a patch that tries to move the shift to another day', () => {
    expect(update.safeParse(['a-1', { date: '2026-11-02' }]).success).toBe(false);
    expect(update.safeParse(['a-1', { nurseId: 'n-2' }]).success).toBe(false);
    expect(update.safeParse(['a-1', { shiftTypeId: 's-2' }]).success).toBe(false);
  });

  it('refuses a flag that is not a yes or no', () => {
    expect(update.safeParse(['a-1', { isOvertime: 'yes' }]).success).toBe(false);
  });

  it('accepts a draft edit sent without a reason or consent', () => {
    // The renderer leaves trailing optional arguments off rather than sending `undefined`; zod 4
    // tuples accept the shorter array, which is what keeps every ordinary grid edit working.
    expect(scheduleSchemas.deleteAssignment.safeParse(['a-1']).success).toBe(true);
    expect(scheduleSchemas.swapAssignments.safeParse(['a-1', 'a-2', 'moved']).success).toBe(true);
    expect(scheduleSchemas.updateAssignment.safeParse(['a-1', { isCharge: true }]).success).toBe(
      true,
    );
  });

  it('refuses a move to a date that does not exist', () => {
    const move = scheduleSchemas.moveAssignment;
    const ok = { assignmentId: 'a-1', nurseId: 'n-1', shiftTypeId: 's-1', date: '2026-11-02' };
    expect(move.safeParse([ok]).success).toBe(true);
    expect(move.safeParse([{ ...ok, date: '2026-13-02' }]).success).toBe(false);
  });
});
