// @vitest-environment jsdom
/**
 * The equity advice on competing requests: the Requests list wording (a pure helper, since the
 * page itself needs a dozen queries) and the block the decide dialog shows above the capacity box.
 */

import { type Conflict, isoDate, type Nurse } from '@shiftnurse/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompetingAdvice, competingNotes } from './competing-advice.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Cruz' } as Nurse;
const ben = { id: 'n-ben', firstName: 'Ben', lastName: 'Okafor' } as Nurse;
const nursesById = new Map([ana, ben].map((n) => [n.id, n]));

const conflict = {
  id: 'competing_time_off:2026-01-10:st:RN',
  kind: 'competing_time_off',
  dates: [isoDate('2026-01-10')],
  timeOffIds: ['r-ana', 'r-ben'],
  advisedOrder: [
    {
      requestId: 'r-ana',
      nurseId: 'n-ana',
      rank: 1,
      approvalRate: 0.4,
      workedHolidayLastYear: null,
      reason: 'Approved 2 of 5 requests (40%); seniority 2019-03-01',
    },
    {
      requestId: 'r-ben',
      nurseId: 'n-ben',
      rank: 2,
      approvalRate: 0.75,
      workedHolidayLastYear: null,
      reason: 'Approved 3 of 4 requests (75%); seniority 2015-01-01',
    },
  ],
} as unknown as Conflict;

afterEach(cleanup);

describe('advice on competing time-off requests', () => {
  it('tells the second request where it stands in line', () => {
    expect(competingNotes([conflict]).get('r-ben')).toEqual([
      'Competes for Sat, Jan 10: 2nd of 2 in line — Approved 3 of 4 requests (75%); seniority 2015-01-01',
    ]);
  });

  it('lists the ranked nurses in the decide dialog and marks the request under decision', () => {
    render(<CompetingAdvice conflicts={[conflict]} requestId="r-ben" nursesById={nursesById} />);
    const block = screen.getByTestId('decide-competing-advice');
    expect(block.textContent).toContain('Who should get it first');
    const items = block.querySelectorAll('li');
    expect(items[0]?.textContent).toBe(
      'Ana Cruz — Approved 2 of 5 requests (40%); seniority 2019-03-01',
    );
    expect(items[1]?.textContent).toBe(
      'Ben Okafor — Approved 3 of 4 requests (75%); seniority 2015-01-01 (this request)',
    );
  });

  it('shows nothing for a request no competing conflict names', () => {
    render(<CompetingAdvice conflicts={[conflict]} requestId="r-other" nursesById={nursesById} />);
    expect(screen.queryByTestId('decide-competing-advice')).toBeNull();
  });
});
