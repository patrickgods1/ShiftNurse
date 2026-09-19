import { describe, expect, it } from 'vitest';
import { assign, DAY_12, NIGHT_12, resetFixtureCounters } from '../testing/fixtures.js';
import { diffAssignments } from './diff.js';

describe('diffAssignments', () => {
  it('reports nothing when the schedule is republished unchanged', () => {
    resetFixtureCounters();
    const before = [assign('n1', DAY_12, '2026-01-05'), assign('n2', NIGHT_12, '2026-01-05')];
    // Same shifts, different row ids: a regenerate rewrites ids but the nurse sees no change.
    const after = [
      assign('n2', NIGHT_12, '2026-01-05', { id: 'x1' }),
      assign('n1', DAY_12, '2026-01-05', { id: 'x2', source: 'solver' }),
    ];
    const diff = diffAssignments(before, after);
    expect(diff.changes).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.changed).toBe(0);
    expect(diff.affectedNurseIds).toEqual([]);
  });

  it('shows a shift moved to another nurse as a removal for one and an addition for the other', () => {
    resetFixtureCounters();
    const before = [assign('n1', DAY_12, '2026-01-05')];
    const after = [assign('n2', DAY_12, '2026-01-05')];
    const diff = diffAssignments(before, after);
    expect(diff.changes.map((c) => [c.kind, c.nurseId])).toEqual([
      ['removed', 'n1'],
      ['added', 'n2'],
    ]);
    expect(diff.affectedNurseIds).toEqual(['n1', 'n2']);
  });

  it('flags a charge or overtime change on a shift the nurse keeps, but ignores the lock', () => {
    resetFixtureCounters();
    const before = [
      assign('n1', DAY_12, '2026-01-05', { isCharge: false, isLocked: false }),
      assign('n1', DAY_12, '2026-01-06', { isLocked: false }),
    ];
    const after = [
      assign('n1', DAY_12, '2026-01-05', { isCharge: true, isLocked: true }),
      assign('n1', DAY_12, '2026-01-06', { isLocked: true }),
    ];
    const diff = diffAssignments(before, after);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      kind: 'changed',
      nurseId: 'n1',
      date: '2026-01-05',
      fields: ['isCharge'],
    });
    expect(diff.changed).toBe(1);
  });

  it('orders changes by date, then nurse, so the diff reads like the grid', () => {
    resetFixtureCounters();
    const after = [
      assign('n9', DAY_12, '2026-01-07'),
      assign('n1', NIGHT_12, '2026-01-07'),
      assign('n5', DAY_12, '2026-01-05'),
    ];
    const diff = diffAssignments([], after);
    expect(diff.changes.map((c) => `${c.date} ${c.nurseId}`)).toEqual([
      '2026-01-05 n5',
      '2026-01-07 n1',
      '2026-01-07 n9',
    ]);
    expect(diff.added).toBe(3);
  });
});
