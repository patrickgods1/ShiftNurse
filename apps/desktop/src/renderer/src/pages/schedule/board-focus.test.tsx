// @vitest-environment jsdom
/**
 * `/schedule?nurse=<id>`: once the roster has loaded the board scrolls that nurse's row into
 * view, and a plain visit to the schedule does not move the page.
 */

import { isoDate, type Nurse, type SchedulePeriod } from '@shiftnurse/core';
import { DAY_12, makeNurse, resetFixtureCounters, testUnit } from '@shiftnurse/core/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
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
