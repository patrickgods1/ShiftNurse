// @vitest-environment jsdom
/**
 * Settings › Pay › Premium stacking: compounding or additive premiums. A save replaces the whole
 * settings row, so the call-back minimum must travel with the choice or it would be reset to zero.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { StackingSection } from './stacking.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'paySettings', {
    callBackMinimumHours: 2,
    premiumStacking: 'compound',
    holidayPayCoversOvertime: false,
    reportingPayNoticeHours: 2,
    overtimeWindowAttribution: 'clock' as const,
    paySpringForwardAsScheduled: false,
    breakPremiumRate: 'base' as const,
  });
  bridge.respond('cost', 'savePaySettings', {
    callBackMinimumHours: 2,
    premiumStacking: 'additive',
    holidayPayCoversOvertime: false,
    reportingPayNoticeHours: 2,
    overtimeWindowAttribution: 'clock' as const,
    paySpringForwardAsScheduled: false,
    breakPremiumRate: 'base' as const,
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('premium stacking in Settings › Pay', () => {
  it('shows the saved choice, with Save off until it changes', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    expect(((await screen.findByLabelText('Premium stacking')) as HTMLSelectElement).value).toBe(
      'compound',
    );
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches to additive and sends the call-back minimum along with it', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Premium stacking'), {
      target: { value: 'additive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          {
            callBackMinimumHours: 2,
            premiumStacking: 'additive',
            holidayPayCoversOvertime: false,
            reportingPayNoticeHours: 2,
            overtimeWindowAttribution: 'clock' as const,
            paySpringForwardAsScheduled: false,
            breakPremiumRate: 'base' as const,
          },
        ],
      ]),
    );
  });

  it('saves that holiday pay covers overtime, keeping the stacking and call-back as they were', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.click(
      await screen.findByLabelText(/Holiday pay covers overtime worked on the holiday/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          {
            callBackMinimumHours: 2,
            premiumStacking: 'compound',
            holidayPayCoversOvertime: true,
            reportingPayNoticeHours: 2,
            overtimeWindowAttribution: 'clock' as const,
            paySpringForwardAsScheduled: false,
            breakPremiumRate: 'base' as const,
          },
        ],
      ]),
    );
  });

  it('keeps pay settings it does not show when it saves', async () => {
    // Stands in for a field a later release adds to the settings row.
    bridge.respond('cost', 'paySettings', {
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      extraField: 7,
    } as never);
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Premium stacking'), {
      target: { value: 'additive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          {
            callBackMinimumHours: 4,
            premiumStacking: 'additive',
            holidayPayCoversOvertime: false,
            extraField: 7,
          },
        ],
      ]),
    );
  });
});

describe('week attribution in Settings › Pay', () => {
  it('saves the week attribution with the rest of the pay settings', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.change(
      await screen.findByLabelText('Shifts that cross into a new work week or pay period'),
      {
        target: { value: 'start' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          {
            callBackMinimumHours: 2,
            premiumStacking: 'compound',
            holidayPayCoversOvertime: false,
            reportingPayNoticeHours: 2,
            overtimeWindowAttribution: 'start',
            paySpringForwardAsScheduled: false,
            breakPremiumRate: 'base',
          },
        ],
      ]),
    );
  });
});

describe('the spring-forward night and missed breaks in Settings › Pay', () => {
  it('saves the spring night as scheduled and breaks at the regular rate with the rest', async () => {
    renderWithApp(<StackingSection unitId="u-1" />);
    fireEvent.click(
      await screen.findByLabelText('Pay the spring-forward night as the hours scheduled'),
    );
    fireEvent.change(screen.getByLabelText('Missed meal and rest breaks are paid at'), {
      target: { value: 'regular' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'savePaySettings')).toEqual([
        [
          'u-1',
          {
            callBackMinimumHours: 2,
            premiumStacking: 'compound',
            holidayPayCoversOvertime: false,
            reportingPayNoticeHours: 2,
            overtimeWindowAttribution: 'clock',
            paySpringForwardAsScheduled: true,
            breakPremiumRate: 'regular',
          },
        ],
      ]),
    );
  });
});
