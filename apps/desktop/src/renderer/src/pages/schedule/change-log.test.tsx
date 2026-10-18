// @vitest-environment jsdom
/** The change log is where a manager answers "why did my Saturday move?". */

import { type Assignment, isoDate, type ScheduleChange, type Unit } from '@shiftnurse/core';
import { DAY_12, makeNurse, resetFixtureCounters } from '@shiftnurse/core/testing';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { ChangeLog } from './change-log.js';

const unit = { id: 'unit-1', name: 'Med-Surg' } as Unit;

let bridge: FakeBridge;
beforeEach(() => {
  resetFixtureCounters();
  bridge = installFakeBridge();
  bridge.respondDefault([]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function assignment(over: Partial<Assignment>): Assignment {
  return {
    id: 'a1',
    periodId: 'p1',
    nurseId: 'n1',
    shiftTypeId: 'st-day',
    date: isoDate('2026-10-10'),
    isLocked: false,
    source: 'manual',
    isCharge: false,
    isOvertime: false,
    ...over,
  };
}

describe('the change log', () => {
  it('quotes the reason typed for a published-shift change, beside what it was and became', async () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Reyes' });
    const day = DAY_12;
    const change: ScheduleChange = {
      id: 'c1',
      periodId: 'p1',
      version: 1,
      kind: 'changed',
      source: 'manual',
      nurseId: ana.id,
      date: isoDate('2026-10-10'),
      shiftTypeId: day.id,
      assignmentId: 'a1',
      before: assignment({ nurseId: ana.id, shiftTypeId: day.id }),
      after: assignment({ nurseId: ana.id, shiftTypeId: day.id, isCharge: true }),
      reason: 'Charge nurse called in sick',
      consent: 'agreed by phone 9 Oct 14:10',
      actor: 'manager',
      at: 0,
    };
    bridge.respond('nurses', 'list', [ana]);
    bridge.respond('shiftTypes', 'list', [day]);
    bridge.respond('publish', 'changes', [change]);
    bridge.respond('publish', 'versions', []);

    renderWithApp(<ChangeLog periodId="p1" />, { unit });

    const entry = await screen.findByTestId('change-log-entry');
    expect(entry.textContent).toContain('Changed — Ana Reyes');
    expect(entry.textContent).toContain('D12 on Oct 10, 2026: plain → charge');
    expect(entry.textContent).toContain('“Charge nurse called in sick”');
    expect(screen.getByTestId('change-consent').textContent).toContain(
      "Nurse's consent: “agreed by phone 9 Oct 14:10”",
    );
    expect(entry.textContent).toContain('grid edit');
    expect(screen.getByText('Changes since publishing (1)')).toBeTruthy();
  });

  it('says so when nothing has been edited since publishing', async () => {
    bridge.respond('publish', 'changes', []);
    bridge.respond('publish', 'versions', []);
    renderWithApp(<ChangeLog periodId="p1" />, { unit });
    expect(await screen.findByText('No edits since this schedule was published.')).toBeTruthy();
  });
});
