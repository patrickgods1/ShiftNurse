// @vitest-environment jsdom
/** A nurse's preference editor tells the truth about what is loaded, what is saved and what is missing. */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { PreferencesSection, preferenceProblems } from './nurse-preferences.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('shiftTypes', 'list', [
    { id: 'st-d', name: 'Day 12' },
    { id: 'st-n', name: 'Night 12' },
  ] as never);
  bridge.respond('holidays', 'list', []);
  bridge.respond('preferences', 'forNurse', []);
  bridge.respond('preferences', 'replace', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const prefersNights = {
  id: 'p1',
  nurseId: 'n-1',
  kind: 'prefer_shift_type',
  shiftTypeId: 'st-n',
  weight: 3,
};

describe('a nurse’s preferences on the roster', () => {
  it('says the preferences could not be loaded, and offers no Save that would wipe them', async () => {
    bridge.fail('preferences', 'forNurse', new Error('database is locked'));
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('database is locked');
    expect(screen.queryByRole('button', { name: 'Save preferences' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull();
    expect(screen.queryByText('No preferences set.')).toBeNull();
  });

  it('offers + Add only once the preferences have loaded', async () => {
    let release: () => void = () => {};
    const ready = new Promise<void>((r) => {
      release = r;
    });
    bridge.respond('preferences', 'forNurse', (() => ready.then(() => [])) as never);
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    await screen.findByText('Loading preferences');
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull();
    release();
    await screen.findByRole('button', { name: '+ Add' });
  });

  it('names the row that still needs a shift type instead of sending it', async () => {
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    expect(screen.getByLabelText('Shift type').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText('Pick a shift type for row 1.').length).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(bridge.callsTo('preferences', 'replace')).toEqual([]);
  });

  it('will not let a nurse both prefer and avoid nights', async () => {
    bridge.respond('preferences', 'forNurse', [prefersNights] as never);
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    const kinds = screen.getAllByLabelText('Preference kind');
    fireEvent.change(kinds[1]!, { target: { value: 'avoid_shift_type' } });
    fireEvent.change(screen.getAllByLabelText('Shift type')[1]!, { target: { value: 'st-n' } });
    expect(
      screen.getAllByText('Row 2 avoids Night 12, which row 1 prefers.').length,
    ).toBeGreaterThan(0);
    const save = screen.getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('offers the holiday wish only when the unit has an upcoming holiday', async () => {
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    const option = screen.getByRole('option', {
      name: 'Wants to work holiday (no upcoming holidays)',
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('saves the rows as shown and keeps them when the list refreshes', async () => {
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Shift type'), { target: { value: 'st-d' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await screen.findByText('Saved');
    expect(bridge.callsTo('preferences', 'replace')).toEqual([
      ['n-1', [{ kind: 'prefer_shift_type', shiftTypeId: 'st-d', weight: 3 }]],
    ]);
    fireEvent.change(screen.getByLabelText('How much it matters'), { target: { value: '5' } });
    await waitFor(() => expect(screen.queryByText('Saved')).toBeNull());
  });

  it('keeps the row the manager is editing when the list refreshes underneath', async () => {
    const { queryClient } = renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    fireEvent.change(screen.getByLabelText('Shift type'), { target: { value: 'st-d' } });
    bridge.respond('preferences', 'forNurse', [prefersNights] as never);
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(bridge.callsTo('preferences', 'forNurse').length).toBeGreaterThan(1),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getAllByLabelText('Shift type')).toHaveLength(1);
    expect((screen.getByLabelText('Shift type') as HTMLSelectElement).value).toBe('st-d');
  });

  it('shows the refreshed list when the manager has not touched the rows', async () => {
    const { queryClient } = renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    await screen.findByText('No preferences set.');
    bridge.respond('preferences', 'forNurse', [prefersNights] as never);
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect((screen.getByLabelText('Shift type') as HTMLSelectElement).value).toBe('st-n'),
    );
  });

  it('calls a second weekend appetite a repeat whatever its value', () => {
    const label = { shiftType: (id: string) => id, weekday: (d: number) => String(d) };
    expect(
      preferenceProblems(
        [
          { kind: 'weekend_appetite', level: 1, weight: 3 },
          { kind: 'weekend_appetite', level: -1, weight: 3 },
        ],
        label,
      ),
    ).toEqual([undefined, 'Row 2 repeats row 1.']);
  });

  it('ties Save to the line that states the first problem', async () => {
    renderWithApp(<PreferencesSection nurseId="n-1" unitId="unit-1" />);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
    const save = screen.getByRole('button', { name: 'Save preferences' });
    const target = document.getElementById(save.getAttribute('aria-describedby') ?? 'none');
    expect(target?.textContent).toBe('Pick a shift type for row 1.');
  });
});
