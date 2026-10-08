// @vitest-environment jsdom
/**
 * Picking a state shows what applying it will do to the leave policy: a preset's policy goes in
 * whole and only into a unit that has none, so a manager who set one is told it stays.
 */

import { isoDate, type LeavePolicy, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PresetRegistry, type RegisteredPreset } from '../setup/preset-registry.js';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { StateLawSection } from './state-law.js';

const unit: Unit = {
  id: 'unit-1',
  name: '4A',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};
const ownPolicy: LeavePolicy = {
  fmla: { regime: 'title1', yearMethod: 'calendar' },
  leaveYearStart: 'calendar',
  accrual: [],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function chooseVa(u: Unit) {
  renderWithApp(<StateLawSection />, { unit: u });
  fireEvent.change(await screen.findByLabelText('State or federal law'), {
    target: { value: 'US-VA' },
  });
}

describe('the state-law preview', () => {
  it('says the VA preset sets the leave policy on a unit that has none', async () => {
    await chooseVa(unit);
    expect((await screen.findByTestId('state-law-leave')).textContent).toBe(
      'Sets the leave policy: Title 5 FMLA, federal leave year, 6 accrual rules.',
    );
  });

  it('says a unit’s own leave policy is left as it is', async () => {
    await chooseVa({ ...unit, leavePolicy: ownPolicy });
    expect((await screen.findByTestId('state-law-leave')).textContent).toBe(
      'Leaves your leave policy as it is.',
    );
  });
});

describe('the state-law picker inside the setup guide', () => {
  let registered: RegisteredPreset | undefined;
  const register = (preset: RegisteredPreset | undefined) => {
    registered = preset;
  };
  const renderInGuide = (offerToContinue = true) => {
    registered = undefined;
    renderWithApp(
      <PresetRegistry.Provider value={register}>
        <StateLawSection offerToContinue={offerToContinue} />
      </PresetRegistry.Provider>,
      { unit },
    );
  };

  it('offers nothing to Continue until a state is chosen', async () => {
    renderInGuide();
    await screen.findByLabelText('State or federal law');
    expect(registered?.disabled()).toBe(true);
  });

  it('lets Continue apply California with its alternative-workweek answer, asking no confirmation', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderInGuide();
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    fireEvent.click(screen.getByTestId('state-law-option-alternativeWorkweek'));
    expect(registered?.label()).toBe('Apply California');
    expect(registered?.disabled()).toBe(false);

    await registered!.run();

    expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([
      ['unit-1', 'CA', { alternativeWorkweek: true }],
    ]);
    expect(screen.queryByText(/never loosens/)).toBeNull();
  });

  it('registers nothing when the step does not offer it to Continue', async () => {
    renderInGuide(false);
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    expect(registered).toBeUndefined();
  });

  it('reads "Record no preset" for Another state', async () => {
    renderInGuide();
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'other' },
    });
    expect(registered?.label()).toBe('Record no preset');
  });
});

describe('the state-law list', () => {
  it('lists states A–Z, then federal, then "Another state" last', async () => {
    renderWithApp(<StateLawSection />, { unit });
    const select = (await screen.findByLabelText('State or federal law')) as HTMLSelectElement;
    const labels = Array.from(select.options)
      .map((o) => o.textContent)
      .slice(1);
    expect(labels.slice(0, 3)).toEqual(['Alaska', 'California', 'Connecticut']);
    expect(labels.slice(-2)).toEqual(['Federal — VA (Title 38)', 'Another state']);
    const states = labels.slice(0, -2);
    expect(states).toEqual([...states].sort((a, b) => a!.localeCompare(b!)));
  });

  it('shows the summary one sentence per line', async () => {
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'WA' },
    });
    const items = screen.getByTestId('state-law-summary').querySelectorAll('li');
    expect(Array.from(items).map((li) => li.textContent)).toEqual([
      'No mandatory overtime in health care facilities (RCW 49.28.140), outside an unforeseeable emergency, prescheduled on-call time, documented efforts to staff, or a procedure in progress.',
      'Record those on the shift as "Emergency: …".',
    ]);
  });
});

describe('the questions a preset asks before it applies', () => {
  it('asks California whether the unit runs a 12-hour alternative workweek', async () => {
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    expect(screen.getByTestId('state-law-option-alternativeWorkweek')).toBeTruthy();
    expect(screen.queryByTestId('state-law-option-compressedTour')).toBeNull();
  });

  it('asks Virginia whether nurses are on compressed tours', async () => {
    await chooseVa(unit);
    expect(screen.getByTestId('state-law-option-compressedTour')).toBeTruthy();
  });

  it('sends the manager’s answer when California is applied', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    fireEvent.click(screen.getByTestId('state-law-option-alternativeWorkweek'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/never loosens a setting you have/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([
        ['unit-1', 'CA', { alternativeWorkweek: true }],
      ]),
    );
  });

  it('unticks the answer when the manager switches state and comes back', async () => {
    renderWithApp(<StateLawSection />, { unit });
    const select = await screen.findByLabelText('State or federal law');
    fireEvent.change(select, { target: { value: 'CA' } });
    fireEvent.click(screen.getByTestId('state-law-option-alternativeWorkweek'));
    fireEvent.change(select, { target: { value: 'US-VA' } });
    fireEvent.change(select, { target: { value: 'CA' } });
    expect(
      (screen.getByTestId('state-law-option-alternativeWorkweek') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('sends no answer when the box is left unticked', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderWithApp(<StateLawSection />, { unit });
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/never loosens a setting you have/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([['unit-1', 'CA', {}]]),
    );
  });
});
