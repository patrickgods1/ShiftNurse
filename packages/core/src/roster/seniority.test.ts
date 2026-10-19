import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { makeNurse } from '../testing/fixtures.js';
import { compareSeniority } from './seniority.js';

describe('who is senior', () => {
  it('puts employee E9 ahead of E10 when they started the same day', () => {
    // 9 < 10 as numbers; a string compare would put "E10" first because '1' < '9'.
    const e9 = makeNurse({ id: 'e9', employeeId: 'E9', seniorityDate: isoDate('2015-01-01') });
    const e10 = makeNurse({ id: 'e10', employeeId: 'E10', seniorityDate: isoDate('2015-01-01') });
    expect([e10, e9].sort(compareSeniority).map((n) => n.id)).toEqual(['e9', 'e10']);
  });

  it('puts the earlier start date first whatever the employee numbers', () => {
    const e9 = makeNurse({ id: 'e9', employeeId: 'E9', seniorityDate: isoDate('2015-01-01') });
    const e10 = makeNurse({ id: 'e10', employeeId: 'E10', seniorityDate: isoDate('2014-01-01') });
    expect([e9, e10].sort(compareSeniority).map((n) => n.id)).toEqual(['e10', 'e9']);
  });
});
