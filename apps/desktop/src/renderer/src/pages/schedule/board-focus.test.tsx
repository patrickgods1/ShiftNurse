// @vitest-environment jsdom
/**
 * `/schedule?nurse=<id>`: once the roster has loaded the board scrolls that nurse's row into
 * view, and a plain visit to the schedule does not move the page.
 */

import type { PeriodCostReport, ScheduleValidation } from '@shared/api.js';
import { type ComplianceAlert, isoDate, type Nurse, type SchedulePeriod } from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  testUnit,
} from '@shiftnurse/core/testing';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ScheduleBoard } from './board.js';

const period: SchedulePeriod = {
  id: 'period-1',
  unitId: testUnit.id,
  name: 'Oct',
  startDate: isoDate('2026-10-05'),
  endDate: isoDate('2026-10-06'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

let bridge: FakeBridge;
const scrollIntoView = vi.fn();
beforeEach(() => {
  resetFixtureCounters();
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('solver', 'current', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const alice = () => makeNurse({ firstName: 'Alice', lastName: 'Adams' });

function renderBoard(nurses: Nurse[], focusNurseId?: string) {
  bridge.respond('nurses', 'list', nurses);
  // The board's rows are the period's roster: here the home nurses, with no floats.
  bridge.respond('nurseUnits', 'roster', nurses);
  bridge.respond('shiftTypes', 'list', [DAY_12]);
  renderWithApp(
    <ScheduleBoard unitId={testUnit.id} period={period} focusNurseId={focusNurseId} />,
    { unit: testUnit },
  );
}

describe('opening the schedule on one nurse', () => {
  it("scrolls Ben's row into view once the roster loads", async () => {
    const ben = makeNurse({ firstName: 'Ben', lastName: 'Brown' });
    renderBoard([alice(), ben], ben.id);
    await screen.findByTestId('schedule-grid');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const row = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(row.getAttribute('data-nurse-id')).toBe(ben.id);
  });

  it('leaves the page where it is when no nurse was asked for', async () => {
    renderBoard([alice()]);
    await screen.findByTestId('schedule-grid');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('"Show on grid" from a compliance alert', () => {
  it("scrolls to Ben's Monday and rings it, then lets the ring go", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ben = makeNurse({ firstName: 'Ben', lastName: 'Brown' });
      const alert: ComplianceAlert = {
        kind: 'overtime',
        severity: 'warning',
        message: 'Ben Brown: 48 hours in the week of Mon, Oct 5',
        nurseId: ben.id,
        date: isoDate('2026-10-05'),
        assignmentIds: [],
      };
      bridge.respond('publish', 'alerts', [alert]);
      // The pills, alerts among them, show once the draft has a shift in it and is judged.
      bridge.respond('periods', 'assignments', [assign(ben.id, DAY_12, '2026-10-05')]);
      bridge.respond('schedule', 'validate', {
        ruleSet: { id: 'rs-1', version: 1, configs: [] },
        result: { violations: [], hardViolations: [], softViolations: [], feasible: true },
        againstPreference: {},
      } as unknown as ScheduleValidation);
      bridge.respond('cost', 'report', {
        period,
        cost: {
          assignments: [],
          totals: { total: 0, hours: 12, base: 0, differentials: 0, overtimePremium: 0 },
          overtime: {
            ranked: [],
            totalHours: 0,
            totalPremium: 0,
            topThreeShare: 0,
            gini: 0,
            nursesWithOvertime: 0,
          },
          unpricedAssignments: 0,
        },
      } as unknown as PeriodCostReport);
      renderBoard([alice(), ben]);
      fireEvent.click(await screen.findByTestId('alerts-panel'));
      fireEvent.click(await screen.findByRole('button', { name: /Show Mon, Oct 5 on the grid/ }));

      const lit = document.querySelector('[role="gridcell"][data-spotlit="cell"]');
      expect(lit?.getAttribute('aria-label')).toMatch(/^Ben Brown, Mon, Oct 5/);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(lit);

      await act(() => vi.advanceTimersByTimeAsync(4500));
      expect(document.querySelector('[data-spotlit]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
