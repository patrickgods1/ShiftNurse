// @vitest-environment jsdom
/**
 * Who worked a past holiday: the list the rotation reads as "last year".
 */

import { type Holiday, isoDate } from '@shiftnurse/core';
import { makeNurse } from '@shiftnurse/core/testing';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { HolidayWorkDialog } from './work-dialog.js';

const christmas: Holiday = {
  id: 'h-1',
  unitId: 'u-1',
  date: isoDate('2025-12-25'),
  name: 'Christmas',
  isMajor: true,
  pairedHolidayId: null,
};

const n1 = makeNurse({ id: 'n-1', firstName: 'Ana', lastName: 'Adams' });
const n2 = makeNurse({ id: 'n-2', firstName: 'Ben', lastName: 'Baker' });

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('nurses', 'list', [n1, n2]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const open = () =>
  renderWithApp(<HolidayWorkDialog unitId="u-1" holiday={christmas} onClose={() => undefined} />);

describe('Settings › Holidays › Who worked', () => {
  it('records who worked a past holiday', async () => {
    bridge.respond('holidays', 'work', {
      holidayId: 'h-1',
      recorded: false,
      nurseIds: [],
      fromSchedules: [],
    });
    bridge.respond('holidays', 'recordWork', {
      holidayId: 'h-1',
      recorded: true,
      nurseIds: ['n-1'],
      fromSchedules: [],
    });
    open();
    fireEvent.click(await screen.findByLabelText('Adams, Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    await waitFor(() => expect(bridge.callsTo('holidays', 'recordWork')).toHaveLength(1));
    expect(bridge.callsTo('holidays', 'recordWork')[0]).toEqual(['h-1', ['n-1']]);
  });

  it('goes back to the published schedules', async () => {
    bridge.respond('holidays', 'work', {
      holidayId: 'h-1',
      recorded: true,
      nurseIds: ['n-2'],
      fromSchedules: ['n-1'],
    });
    bridge.respond('holidays', 'clearWork', {
      holidayId: 'h-1',
      recorded: false,
      nurseIds: ['n-1'],
      fromSchedules: ['n-1'],
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Use published schedules' }));
    await waitFor(() => expect(bridge.callsTo('holidays', 'clearWork')).toHaveLength(1));
    expect(bridge.callsTo('holidays', 'clearWork')[0]).toEqual(['h-1']);
  });
});
