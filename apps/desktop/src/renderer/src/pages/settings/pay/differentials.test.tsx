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

    it('saves the 2025–2030 tiers for runs of 8s, 10s and 12s', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('Full shift (hours)'), { target: { value: '8' } });
      fireEvent.change(screen.getByLabelText('More than (full shifts)'), {
        target: { value: '6' },
      });
      fireEvent.change(screen.getByLabelText('Within (days)'), { target: { value: '6' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add a tier' }));
      fireEvent.change(screen.getByLabelText('Tier 2: Full shift (hours)'), {
        target: { value: '10' },
      });
      fireEvent.change(screen.getByLabelText('Tier 2: More than (full shifts)'), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText('Tier 2: Within (days)'), { target: { value: '5' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add a tier' }));
      fireEvent.change(screen.getByLabelText('Tier 3: Full shift (hours)'), {
        target: { value: '12' },
      });
      fireEvent.change(screen.getByLabelText('Tier 3: More than (full shifts)'), {
        target: { value: '4' },
      });
      fireEvent.change(screen.getByLabelText('Tier 3: Within (days)'), { target: { value: '4' } });
      // Three is the most a premium holds.
      expect(screen.queryByRole('button', { name: 'Add a tier' })).toBeNull();
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
              consecutive: {
                afterShifts: 4,
                withinDays: 4,
                tiers: [
                  { fullShiftHours: 8, afterShifts: 6, withinDays: 6 },
                  { fullShiftHours: 10, afterShifts: 5, withinDays: 5 },
                  { fullShiftHours: 12, afterShifts: 4, withinDays: 4 },
                ],
              },
            },
          ],
        ]),
      );
    });

    it('will not save two tiers for the same shift length', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('More than (full shifts)'), {
        target: { value: '4' },
      });
      fireEvent.change(screen.getByLabelText('Within (days)'), { target: { value: '4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add a tier' }));
      fireEvent.change(screen.getByLabelText('Tier 2: Full shift (hours)'), {
        target: { value: '12' },
      });
      fireEvent.change(screen.getByLabelText('Tier 2: More than (full shifts)'), {
        target: { value: '3' },
      });
      fireEvent.change(screen.getByLabelText('Tier 2: Within (days)'), { target: { value: '3' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
      expect(await screen.findByText('Each tier needs its own full-shift hours')).toBeTruthy();
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([]);
    });
  });

  describe('the UC short-rest premium', () => {
    async function choosePremium() {
      await openForm();
      fireEvent.change(screen.getByTestId('differential-kind'), {
        target: { value: 'short_rest' },
      });
      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'multiplier' } });
      fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '1.5' } });
    }

    it('saves time and a half on the whole shift after less than six hours off', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('Less than (hours off)'), { target: { value: '6' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
      await waitFor(() =>
        expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
          [
            {
              unitId: 'u-1',
              kind: 'short_rest',
              mode: 'multiplier',
              amount: 1.5,
              active: true,
              shortRest: { minHoursOff: 6, scope: 'whole_shift' },
            },
          ],
        ]),
      );
    });

    it('saves a premium on only the hours before twelve hours off would have ended', async () => {
      await choosePremium();
      fireEvent.change(screen.getByLabelText('Less than (hours off)'), { target: { value: '12' } });
      fireEvent.change(screen.getByLabelText('Paid on'), { target: { value: 'within_window' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
      await waitFor(() =>
        expect(bridge.callsTo('cost', 'createDifferential')[0]?.[0]).toMatchObject({
          shortRest: { minHoursOff: 12, scope: 'within_window' },
        }),
      );
    });

    it('will not save the premium without its hours off', async () => {
      await choosePremium();
      fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
      expect(await screen.findByText('Enter the hours off the contract asks for')).toBeTruthy();
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

    it('puts the row back when the manager cancels an edit', async () => {
      bridge.respond('cost', 'differentials', [windowedNight]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      const amount = screen.getAllByLabelText('Amount').at(-1) as HTMLInputElement;
      fireEvent.change(amount, { target: { value: '1.4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect((screen.getAllByLabelText('Amount').at(-1) as HTMLInputElement).value).toBe('1.1');
      expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([]);
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

  describe('amounts the cost engine can price', () => {
    const holiday = {
      id: 'd1',
      unitId: 'u-1',
      kind: 'holiday' as const,
      mode: 'multiplier' as const,
      amount: 1.5,
      active: true,
    };
    const night = (id: string, amount: number) => ({
      id,
      unitId: 'u-1',
      kind: 'night' as const,
      mode: 'flat' as const,
      amount,
      active: true,
    });

    it('refuses a holiday multiplier of 0.5', async () => {
      await openForm();
      fireEvent.change(screen.getByTestId('differential-kind'), { target: { value: 'holiday' } });
      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'multiplier' } });
      fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '0.5' } });
      // Submitted directly: the input's own min would otherwise stop the click before our check.
      fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
      expect(
        await screen.findByText('A multiplier must be at least 1 (1.5 is time and a half).'),
      ).toBeTruthy();
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([]);
    });

    it('saves on-call standby at 15% of basic pay', async () => {
      await openForm();
      fireEvent.change(screen.getByTestId('differential-kind'), { target: { value: 'on_call' } });
      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'multiplier' } });
      fireEvent.change(screen.getByTestId('differential-amount'), { target: { value: '0.15' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add differential' }));
      await waitFor(() =>
        expect(bridge.callsTo('cost', 'createDifferential')).toEqual([
          [{ unitId: 'u-1', kind: 'on_call', mode: 'multiplier', amount: 0.15, active: true }],
        ]),
      );
    });

    it('asks for an amount when it is left blank', async () => {
      await openForm();
      fireEvent.submit(screen.getByRole('button', { name: 'Add differential' }).closest('form')!);
      expect(await screen.findByText('Enter an amount.')).toBeTruthy();
      expect(bridge.callsTo('cost', 'createDifferential')).toEqual([]);
    });

    it('does not save a cleared amount as zero when editing', async () => {
      bridge.respond('cost', 'differentials', [holiday]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Enter an amount.')).toBeTruthy();
      expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([]);
    });

    it('refuses editing a holiday premium down to 0.8', async () => {
      bridge.respond('cost', 'differentials', [holiday]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.8' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(
        await screen.findByText('A multiplier must be at least 1 (1.5 is time and a half).'),
      ).toBeTruthy();
      expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([]);
    });

    it('warns when two night differentials are both active', async () => {
      bridge.respond('cost', 'differentials', [night('d1', 2), night('d2', 4)]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      await screen.findAllByRole('button', { name: 'Edit' });
      expect(
        screen.getAllByText('Two active night differentials: only one is paid. Turn one off.'),
      ).toHaveLength(2);
    });

    it('does not warn about a night rate waiting inactive', async () => {
      bridge.respond('cost', 'differentials', [
        night('d1', 2),
        { ...night('d2', 4), active: false },
      ]);
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      await screen.findAllByRole('button', { name: 'Edit' });
      expect(screen.queryByText(/Two active/)).toBeNull();
    });

    it('says why turning on a second night rate was refused', async () => {
      const refusal =
        'This unit already has an active night differential, and only one of each kind is paid. Change its amount, or turn it off first.';
      bridge.respond('cost', 'differentials', [
        night('d1', 2),
        { ...night('d2', 4), active: false },
      ]);
      bridge.fail('cost', 'updateDifferential', new Error(refusal));
      renderWithApp(<DifferentialsSection unitId="u-1" />);
      const [, second] = await screen.findAllByLabelText('Night differential active');
      fireEvent.click(second!);
      // The toast is an alert too; the line under the table carries the message alone.
      await waitFor(() =>
        expect(screen.getAllByRole('alert').map((el) => el.textContent)).toContain(refusal),
      );
      expect(bridge.callsTo('cost', 'updateDifferential')).toEqual([['d2', { active: true }]]);
    });
  });
});
