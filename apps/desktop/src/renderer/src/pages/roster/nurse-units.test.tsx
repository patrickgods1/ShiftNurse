// @vitest-environment jsdom
/**
 * Roster › nurse drawer › Also works on: the units a nurse may float to. Each button leads to
 * exactly the payload that would cross IPC, and a refusal from main (shifts still on the unit)
 * reads as written.
 */

import type { NurseUnit } from '@shared/api.js';
import type { Nurse, Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { AlsoWorksOnSection } from './nurse-units.js';

const ana = { id: 'n-ana', unitId: 'u-4w', firstName: 'Ana', lastName: 'Cruz' } as Nurse;
const units = [
  { id: 'u-4w', name: '4 West' },
  { id: 'u-5w', name: '5 West' },
  { id: 'u-icu', name: 'ICU' },
] as Unit[];
const onFiveWest: NurseUnit = {
  id: 'nu-1',
  nurseId: 'n-ana',
  unitId: 'u-5w',
  competency: 'Telemetry',
  startDate: '2026-10-01' as NurseUnit['startDate'],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('units', 'list', units);
  bridge.respond('nurseUnits', 'forNurse', [onFiveWest]);
  bridge.respond('nurseUnits', 'create', onFiveWest);
  bridge.respond('nurseUnits', 'update', onFiveWest);
  bridge.respond('nurseUnits', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a nurse who also works on other units', () => {
  it('lists the unit with its note and says when it starts', async () => {
    renderWithApp(<AlsoWorksOnSection nurse={ana} />);
    expect(await screen.findByText('5 West')).toBeTruthy();
    expect(screen.getByText('Telemetry')).toBeTruthy();
    expect(screen.getByText(/^From /)).toBeTruthy();
  });

  it('adds ICU with a competency note and no dates', async () => {
    renderWithApp(<AlsoWorksOnSection nurse={ana} />);
    await screen.findByText('5 West');
    fireEvent.click(screen.getByRole('button', { name: 'Add a unit' }));
    // 5 West is already on the list, so the choice starts at the one that is not.
    expect((screen.getByLabelText('Unit') as HTMLSelectElement).value).toBe('u-icu');
    fireEvent.change(screen.getByLabelText('Competency note (optional)'), {
      target: { value: ' Central lines ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('nurseUnits', 'create')).toEqual([
        [{ nurseId: 'n-ana', unitId: 'u-icu', competency: 'Central lines' }],
      ]),
    );
  });

  it('clears the note with null when its box is emptied', async () => {
    renderWithApp(<AlsoWorksOnSection nurse={ana} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit 5 West' }));
    fireEvent.change(screen.getByLabelText('Competency note (optional)'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('nurseUnits', 'update')).toEqual([
        ['nu-1', { competency: null, startDate: '2026-10-01', endDate: null }],
      ]),
    );
  });

  it('shows the refusal in words when the nurse still has shifts on that unit', async () => {
    bridge.fail(
      'nurseUnits',
      'remove',
      new Error('Ana Cruz still has 2 shifts on 5 West; take them off the schedule first'),
    );
    renderWithApp(<AlsoWorksOnSection nurse={ana} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove 5 West' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect((await screen.findByRole('alert')).textContent).toContain('still has 2 shifts');
  });
});
