// @vitest-environment jsdom
/**
 * Settings › Pay › Differentials: a night or evening premium earned by the clock. The click leads
 * to exactly the payload that would cross IPC, and an evening premium with no window is not sent.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { DifferentialsSection } from './differentials.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'differentials', []);
  bridge.respond('cost', 'createDifferential', {
    id: 'd-1',
    unitId: 'u-1',
    kind: 'night',
    mode: 'multiplier',
    amount: 1.1,
    active: true,
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function openForm() {
  renderWithApp(<DifferentialsSection unitId="u-1" />);
  await screen.findByTestId('differential-kind');
}

describe('clock-time differentials in Settings › Pay', () => {
  it('saves a VA-style night differential for 18:00 to 06:00, whole tour from 4 hours', async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'multiplier' } });
    fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '1.1' } });
    fireEvent.click(screen.getByLabelText('By clock time'));
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '06:00' } });
    fireEvent.change(screen.getByLabelText('Whole shift when at least (hours)'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
        [
          {
            unitId: 'u-1',
            kind: 'night',
            mode: 'multiplier',
            amount: 1.1,
            active: true,
            window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 },
          },
        ],
      ]),
    );
  });

  it('saves a night differential by the shift type flag when By clock time is off', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '4.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
        [{ unitId: 'u-1', kind: 'night', mode: 'flat', amount: 4.5, active: true }],
      ]),
    );
  });

  it('asks for a window when adding an evening differential without one', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('differential-kind'), { target: { value: 'evening' } });
    fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '15:00' } });
    // The end time is left empty: the browser's own required check is bypassed by submitting.
    fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
    expect(await screen.findByText('Enter a start and an end time for the window')).toBeTruthy();
    expect(bridge.callsTo('cost', 'createDifferential')).toEqual([]);
  });

  it('saves an evening differential for 15:00 to 23:00 that pays only the hours inside', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('differential-kind'), { target: { value: 'evening' } });
    fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '15:00' } });
    fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '23:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
        [
          {
            unitId: 'u-1',
            kind: 'evening',
            mode: 'flat',
            amount: 2,
            active: true,
            window: { startTime: '15:00', endTime: '23:00', wholeShiftAtHours: null },
          },
        ],
      ]),
    );
  });

  describe('the UC consecutive-shift premium', () => {
    async function choosePremium() {
      await openForm();
      fireEvent.change(screen.getByTestId('differential-kind'), {
        target: { value: 'consecutive_shift' },
      });
      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'multiplier' } });
      fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '1.5' } });
    }

    it('saves time and a half after more than four full shifts within four days', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('More than (full shifts)'), {
        target: { value: '4' },
      });
      fireEvent.change(screen.getByLabelText('Within (days)'), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
      await waitFor(() =>
        expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
          [
            {
              unitId: 'u-1',
              kind: 'consecutive_shift',
              mode: 'multiplier',
              amount: 1.5,
              active: true,
              consecutive: { afterShifts: 4, withinDays: 4 },
            },
          ],
        ]),
      );
    });

    it('will not save the premium with the shifts but not the days', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('More than (full shifts)'), {
        target: { value: '4' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
      expect(
        await screen.findByText('Enter both the number of shifts and the number of days'),
      ).toBeTruthy();
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([]);
    });
  });

  describe('editing a saved differential', () => {
    const windowedNight = {
      id: 'd-night',
      unitId: 'u-1',
      kind: 'night' as const,
      mode: 'multiplier' as const,
      amount: 1.1,
      active: true,
      window: { startTime: '18:00', endTime: '06:00', wholeShiftAtHours: 4 },
    };
    const windowedEvening = {
      id: 'd-evening',
      unitId: 'u-1',
      kind: 'evening' as const,
      mode: 'flat' as const,
      amount: 2,
      active: true,
      window: { startTime: '15:00', endTime: '23:00', wholeShiftAtHours: null },
    };

    it('goes back to the shift type flag when By clock time is unticked on a night', async () => {
      bridge.respond('cost', 'differentials', [windowedNight]);
      bridge.respond('cost', 'updateDifferential', windowedNight);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const tick = screen.getAllByLabelText('By clock time').at(-1)!;
      expect((tick as HTMLInputElement).checked).toBe(true);
      fireEvent.click(tick);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([
          ['d-night', { amount: 1.1, window: null }],
        ]),
      );
    });

    it('will not let an evening differential lose its window', async () => {
      bridge.respond('cost', 'differentials', [windowedEvening]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Window start'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Window end'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('An evening differential needs a window')).toBeTruthy();
      expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([]);
    });
  });
});
