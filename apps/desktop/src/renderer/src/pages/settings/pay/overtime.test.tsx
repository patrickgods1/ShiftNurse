// @vitest-environment jsdom
/**
 * Settings › Pay › Overtime: the two bases a holdover and a long unbroken stretch are priced by.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { OvertimeSection } from './overtime.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'overtimeRules', []);
  bridge.respond('cost', 'createOvertimeRule', {} as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('overtime bases in Settings › Pay', () => {
  it('offers overtime past the end of the scheduled tour and for consecutive hours', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = (await screen.findByLabelText('Basis')) as HTMLSelectElement;
    const options = Array.from(basis.options).map((o) => [o.value, o.text]);
    expect(options).toContainEqual(['beyond_scheduled_tour', 'Past the end of the scheduled tour']);
    expect(options).toContainEqual(['consecutive', 'Consecutive hours worked']);
  });

  it('explains the threshold for each, and saves a consecutive-hours rule', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = await screen.findByLabelText('Basis');
    fireEvent.change(basis, { target: { value: 'beyond_scheduled_tour' } });
    expect(screen.getByText('Grace before a holdover becomes overtime; 0 for none.')).toBeTruthy();
    fireEvent.change(basis, { target: { value: 'consecutive' } });
    expect(screen.getByText(/38 U\.S\.C\. §7453\(e\): 8/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Threshold (hours)'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createOvertimeRule')).toEqual([
        [{ unitId: 'u-1', basis: 'consecutive', thresholdHours: 8, multiplier: 1.5, active: true }],
      ]),
    );
  });
});
