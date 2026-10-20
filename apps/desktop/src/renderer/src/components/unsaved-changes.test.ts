import { describe, expect, it } from 'vitest';
import { listLabels } from './unsaved-changes.js';

describe('naming what is unsaved', () => {
  it.each([
    [['Rules'], 'Rules'],
    [['Rules', 'Solver'], 'Rules and Solver'],
    [['Rules', 'Solver', 'Unit'], 'Rules, Solver and Unit'],
    [['Rules', 'Rules'], 'Rules'],
  ])('lists %j as "%s"', (labels, expected) => {
    expect(listLabels(labels)).toBe(expected);
  });
});
