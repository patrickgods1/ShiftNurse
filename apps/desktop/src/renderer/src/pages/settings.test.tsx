// @vitest-environment jsdom
/**
 * The Settings side list is how a manager finds "where do I change X": grouped by their
 * questions, and openable by URL from the grid and the Requests page.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import SettingsPage from './settings.js';

// The panels fetch their own data; this test is about the list around them.
vi.mock('./settings/unit.js', () => ({ default: () => <p>unit panel</p> }));
vi.mock('./settings/shift-types.js', () => ({ default: () => <p>shift types panel</p> }));
vi.mock('./settings/holidays.js', () => ({ default: () => <p>holidays panel</p> }));
vi.mock('./settings/rules.js', () => ({ default: () => <p>rules panel</p> }));

beforeEach(() => {
  installFakeBridge();
});
afterEach(() => {
  cleanup();
});

describe('Settings › About', () => {
  it('lists the nine things a manager still does by hand, and says the presets are not legal advice', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings?tab=about' });
    const list = await screen.findByTestId('not-enforced');
    expect(list.querySelectorAll('li')).toHaveLength(9);
    expect(list.textContent).toContain('ORS 441.768');
    expect(
      screen.getByRole('heading', { name: 'What ShiftNurse does not enforce yet' }),
    ).toBeTruthy();
    expect(screen.getByText(/not legal advice/)).toBeTruthy();
  });
});

describe('Settings navigation', () => {
  it('groups the sections under the headings a manager looks for', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings' });
    for (const heading of ['My unit', 'Contract & pay', 'Scheduling', 'Data']) {
      expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(screen.getByRole('tab', { name: 'Schedule builder' }).id).toBe('settings-tab-solver');
    expect(screen.getByRole('tab', { name: 'Requests' }).id).toBe('settings-tab-conflicts');
    expect(screen.getByRole('tab', { name: 'Leave' }).id).toBe('settings-tab-leave');
    expect(screen.getAllByRole('tab')).toHaveLength(12);
    // A tablist owns only tabs, so each group is its own list, named by its heading.
    expect(screen.getAllByRole('tablist')).toHaveLength(4);
    expect(screen.getByRole('tablist', { name: 'Data' })).toBeTruthy();
  });

  it('opens Rules when the link says tab=rules', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings?tab=rules&rule=rest-hours' });
    expect(await screen.findByText('rules panel')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true');
  });

  it('walks from the last tab of one group to the first of the next', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings?tab=holidays' });
    const holidays = await screen.findByRole('tab', { name: 'Holidays' });
    fireEvent.keyDown(holidays, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Rules' }).getAttribute('aria-selected')).toBe('true'),
    );
  });

  it('opens Unit by default and moves with the arrow keys', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings' });
    const unit = await screen.findByRole('tab', { name: 'Unit' });
    expect(unit.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(unit, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Shift types' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });
});
