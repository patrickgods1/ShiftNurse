import { describe, expect, it } from 'vitest';
import { labelledIndices } from './trend-panel.js';

describe('trend date labels', () => {
  it('labels every period when there are six or fewer', () => {
    expect(labelledIndices(5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('drops the label that would sit on top of the last one with eight periods', () => {
    expect(labelledIndices(8)).toEqual([0, 2, 4, 7]);
  });

  it('keeps labels a full step apart with nine periods', () => {
    expect(labelledIndices(9)).toEqual([0, 3, 8]);
  });

  it('keeps labels a full step apart with twelve periods', () => {
    expect(labelledIndices(12)).toEqual([0, 3, 6, 11]);
  });
});
