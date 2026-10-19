// @vitest-environment jsdom
/**
 * Roster › Accommodations: the manager records a recurring window with its reason, and each
 * button leads to exactly the payload that would cross IPC.
 */

import type { AvailabilityBlock, IsoDate, Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { AccommodationsSection } from './accommodations.js';

const nina = { id: 'n-nina', firstName: 'Nina', lastName: 'Park', active: true } as Nurse;
const vera = { id: 'n-vera', firstName: 'Vera', lastName: 'Lund', active: true } as Nurse;

const record: AvailabilityBlock = {
  id: 'ablk-1',
  unitId: 'unit-1',
  nurseId: 'n-nina',
  weekdays: [5],
  startTime: '18:00',
  endTime: '18:00',
  reason: 'Keeps the Sabbath',
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('availabilityBlocks', 'list', [record]);
  bridge.respond('availabilityBlocks', 'create', record);
  bridge.respond('availabilityBlocks', 'update', record);
  bridge.respond('availabilityBlocks', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderSection = () =>
  renderWithApp(<AccommodationsSection unitId="unit-1" nurses={[nina, vera]} />);

describe('recording an accommodation on the roster', () => {
  it('gives two accommodations for one nurse distinct button names', async () => {
    bridge.respond('availabilityBlocks', 'list', [
      { ...record, startsOn: '2026-10-01' as IsoDate, endsOn: '2026-12-31' as IsoDate },
      {
        ...record,
        id: 'ablk-2',
        startsOn: '2027-01-01' as IsoDate,
        endsOn: '2027-03-31' as IsoDate,
      },
    ]);
    renderSection();
    expect(
      await screen.findByRole('button', {
        name: 'Edit Nina Park’s accommodation, Oct 1, 2026 to Dec 31, 2026',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'Edit Nina Park’s accommodation, Jan 1, 2027 to Mar 31, 2027',
      }),
    ).toBeTruthy();
  });

  it('lists the nurse, the window and the reason, with what an accommodation does', async () => {
    renderSection();
    expect(await screen.findByText('Nina Park')).toBeTruthy();
    expect(screen.getByText('Fri')).toBeTruthy();
    expect(screen.getByText(/18:00 – 18:00/)).toBeTruthy();
    expect(screen.getByText('Keeps the Sabbath')).toBeTruthy();
    expect(
      screen.getByText(
        'A recurring window this nurse cannot work — a religious, disability, pregnancy or lactation accommodation. Generate never schedules into it.',
      ),
    ).toBeTruthy();
  });

  it('will not save without a reason', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByTestId('accommodation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-vera' } });
    fireEvent.click(dialog.getByLabelText('Fri'));
    fireEvent.change(dialog.getByLabelText('Starts at'), { target: { value: '18:00' } });
    fireEvent.change(dialog.getByLabelText('Ends at'), { target: { value: '18:00' } });
    expect(dialog.getByText('Say why this accommodation exists; it is kept for HR.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('records an accommodation with its reason', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByTestId('accommodation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-vera' } });
    fireEvent.click(dialog.getByLabelText('Fri'));
    fireEvent.change(dialog.getByLabelText('Starts at'), { target: { value: '18:00' } });
    fireEvent.change(dialog.getByLabelText('Ends at'), { target: { value: '18:00' } });
    fireEvent.change(dialog.getByLabelText('Why this accommodation exists'), {
      target: { value: ' Sabbath ' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('availabilityBlocks', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            nurseId: 'n-vera',
            weekdays: [5],
            startTime: '18:00',
            endTime: '18:00',
            reason: 'Sabbath',
          },
        ],
      ]),
    );
  });

  it('edits a window and keeps why the accommodation exists', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByRole('button', { name: /Edit Nina Park/ }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Ends at'), { target: { value: '19:00' } });
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Sunset moved' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('availabilityBlocks', 'update')).toEqual([
        [
          'ablk-1',
          {
            weekdays: [5],
            startTime: '18:00',
            endTime: '19:00',
            startsOn: null,
            endsOn: null,
          },
          'Sunset moved',
        ],
      ]),
    );
    // toEqual lets an undefined key through; the basis must not be in the patch at all.
    const patch = bridge.callsTo('availabilityBlocks', 'update')[0]![1] as object;
    expect(Object.keys(patch).includes('reason')).toBe(false);
  });

  it('rewrites why the accommodation exists when the manager edits it', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByRole('button', { name: /Edit Nina Park/ }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Why this accommodation exists'), {
      target: { value: 'Sabbath, sunset to sunset' },
    });
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Wording' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('availabilityBlocks', 'update')).toHaveLength(1));
    const call = bridge.callsTo('availabilityBlocks', 'update')[0]!;
    expect(call[1]).toMatchObject({ reason: 'Sabbath, sunset to sunset' });
    expect(call[2]).toBe('Wording');
  });

  it('will not save an edit without saying why it changed', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByRole('button', { name: /Edit Nina Park/ }));
    const dialog = within(await screen.findByRole('dialog'));
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Sunset moved' },
    });
    expect(save.disabled).toBe(false);
  });

  it('removes an accommodation only once a reason is given', async () => {
    renderSection();
    await screen.findByText('Nina Park');
    fireEvent.click(screen.getByRole('button', { name: /Remove Nina Park/ }));
    const dialog = within(await screen.findByRole('dialog'));
    expect((dialog.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(dialog.getByLabelText('Reason for removing it'), {
      target: { value: 'No longer needed' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(bridge.callsTo('availabilityBlocks', 'remove')).toEqual([
        ['ablk-1', 'No longer needed'],
      ]),
    );
  });
});
