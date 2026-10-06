// @vitest-environment jsdom
/**
 * Requests › Holiday requests: the contract's order shown to the manager, as advice. The reasons
 * are read to nurses, so they reach the screen word for word.
 */

import type { HolidayClaim, Nurse } from '@shiftnurse/core';
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { HolidayRequestsPanel, holidayNotes } from './holiday-requests-panel.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Martinez' } as Nurse;
const ben = { id: 'n-ben', firstName: 'Ben', lastName: 'Okafor' } as Nurse;
const cal = { id: 'n-cal', firstName: 'Cal', lastName: 'Dunn' } as Nurse;
const nursesById = new Map([ana, ben, cal].map((n) => [n.id, n]));

const claim: HolidayClaim = {
  holidayId: 'h-1',
  date: '2026-12-25' as HolidayClaim['date'],
  name: 'Christmas Day',
  alreadyOff: ['n-cal'],
  claimants: [
    {
      requestId: 'r-ben',
      nurseId: 'n-ben',
      rank: 1,
      workedLastYear: true,
      reason: 'Worked Christmas Day last year; seniority 2015-06-01',
    },
    {
      requestId: 'r-ana',
      nurseId: 'n-ana',
      rank: 2,
      workedLastYear: false,
      reason: 'Had Christmas Day off last year; seniority 2008-03-01',
    },
  ],
};

// Radix positions the tip with a ResizeObserver, which jsdom lacks.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let bridge: FakeBridge;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
  vi.unstubAllGlobals();
});

describe('holiday requests on the Requests page', () => {
  it('lists the claimants in contract order with the reason and who is already off', async () => {
    bridge.respond('timeOff', 'holidayPriority', [claim]);
    renderWithApp(<HolidayRequestsPanel unitId="unit-1" nursesById={nursesById} />);
    expect(await screen.findByText(/Christmas Day · /)).toBeTruthy();
    const items = [...document.querySelectorAll('ol > li')].map((li) => li.textContent);
    expect(items[0]).toContain('1. Ben Okafor');
    expect(items[0]).toContain('Worked Christmas Day last year; seniority 2015-06-01');
    expect(items[1]).toContain('2. Ana Martinez');
    expect(screen.getByText('Already off: Cal Dunn')).toBeTruthy();
    const tip = screen.getByRole('button', { name: 'About Holiday requests' });
    act(() => tip.focus());
    const text =
      'The order the contract gives: whoever worked this holiday last year, then seniority. ' +
      'Peers agreeing among themselves comes first; record that by deciding.';
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('says so when no pending request covers a holiday', async () => {
    bridge.respond('timeOff', 'holidayPriority', []);
    renderWithApp(<HolidayRequestsPanel unitId="unit-1" nursesById={nursesById} />);
    expect(await screen.findByText('No pending request covers a holiday.')).toBeTruthy();
  });

  it('says a lone request is the only one for its holiday', () => {
    const lone: HolidayClaim = { ...claim, claimants: [claim.claimants[0]!] };
    expect(holidayNotes([lone]).get('r-ben')).toEqual(['Only request for Christmas Day']);
  });

  it('notes each request’s place in line', () => {
    const notes = holidayNotes([claim]);
    expect(notes.get('r-ana')).toEqual(['Holiday priority 2 of 2 for Christmas Day']);
    expect(notes.get('r-ben')).toEqual(['Holiday priority 1 of 2 for Christmas Day']);
  });
});
