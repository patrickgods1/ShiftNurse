import { describe, expect, it } from 'vitest';

import { isoDate } from '../domain/time.js';
import { timeOff } from '../testing/fixtures.js';
import { daysAvailable } from './exposure.js';

const START = isoDate('2026-03-01');
const END = isoDate('2026-03-14');
const ana = { id: 'ana' };

describe('days a nurse was available in a period', () => {
  it('counts every day for a nurse with no leave', () => {
    expect(daysAvailable(ana, START, END, [])).toBe(14);
  });

  it('takes out approved leave days inside the period, not the ones before it', () => {
    // Leave Feb 25 – Mar 3: only Mar 1, 2, 3 fall in the period, so 14 - 3.
    const leave = [timeOff('ana', '2026-02-25', '2026-03-03')];
    expect(daysAvailable(ana, START, END, leave)).toBe(11);
  });

  it('ignores requests still pending or denied', () => {
    const requests = [
      timeOff('ana', '2026-03-05', '2026-03-08', { id: 'p', status: 'pending' }),
      timeOff('ana', '2026-03-05', '2026-03-08', { id: 'd', status: 'denied' }),
    ];
    expect(daysAvailable(ana, START, END, requests)).toBe(14);
  });

  it('counts a day covered by two approved requests once', () => {
    // Mar 5–8 and Mar 7–10 together cover Mar 5–10, six days: 14 - 6.
    const requests = [
      timeOff('ana', '2026-03-05', '2026-03-08', { type: 'pto' }),
      timeOff('ana', '2026-03-07', '2026-03-10', { type: 'fmla' }),
    ];
    expect(daysAvailable(ana, START, END, requests)).toBe(8);
  });

  it('counts a new hire from her first day only', () => {
    // Hired Mar 10: Mar 10, 11, 12, 13, 14.
    const newHire = { id: 'ana', hireDate: isoDate('2026-03-10') };
    expect(daysAvailable(newHire, START, END, [])).toBe(5);
  });

  it("does not count a colleague's leave", () => {
    const leave = [timeOff('bea', '2026-03-01', '2026-03-14', { type: 'fmla' })];
    expect(daysAvailable(ana, START, END, leave)).toBe(14);
  });
});
