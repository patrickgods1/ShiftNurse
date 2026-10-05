// @vitest-environment jsdom
/**
 * Roster › Orientation: the manager pairs a new nurse with the preceptors who oversee them, and
 * each button leads to exactly the payload that would cross IPC.
 */

import type { Nurse, Preceptorship } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { OrientationSection } from './orientation.js';

const nina = { id: 'n-nina', firstName: 'Nina', lastName: 'Park', active: true } as Nurse;
const vera = { id: 'n-vera', firstName: 'Vera', lastName: 'Lund', active: true } as Nurse;
const omar = { id: 'n-omar', firstName: 'Omar', lastName: 'Diaz', active: true } as Nurse;

const record: Preceptorship = {
  id: 'prec-1',
  unitId: 'unit-1',
  orienteeId: 'n-nina',
  preceptorId: 'n-vera',
  startDate: '2026-10-05' as Preceptorship['startDate'],
  endDate: '2026-11-15' as Preceptorship['endDate'],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('preceptorships', 'list', [record]);
  bridge.respond('preceptorships', 'create', [record]);
  bridge.respond('preceptorships', 'update', record);
  bridge.respond('preceptorships', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderSection = () =>
  renderWithApp(<OrientationSection unitId="unit-1" nurses={[nina, vera, omar]} />);

describe('recording an orientation on the roster', () => {
  it('lists who is oriented by whom and says what an orientation does', async () => {
    renderSection();
    expect(await screen.findByText('Nina Park with Vera Lund')).toBeTruthy();
    expect(
      screen.getByText(
        'An orientee works only on shifts one of their preceptors is on; Generate keeps them together.',
      ),
    ).toBeTruthy();
  });

  it('records one orientation with two preceptors', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByTestId('orientation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Orientee'), { target: { value: 'n-nina' } });
    fireEvent.click(dialog.getByLabelText('Vera Lund'));
    fireEvent.click(dialog.getByLabelText('Omar Diaz'));
    fireEvent.change(dialog.getByLabelText('First day'), { target: { value: '2026-10-05' } });
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-11-15' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('preceptorships', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            orienteeId: 'n-nina',
            preceptorIds: ['n-vera', 'n-omar'],
            startDate: '2026-10-05',
            endDate: '2026-11-15',
          },
        ],
      ]),
    );
  });

  it('will not save without a preceptor', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByTestId('orientation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Orientee'), { target: { value: 'n-nina' } });
    expect(dialog.getByText('Choose at least one preceptor.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('extends the orientation’s last day', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-12-01' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('preceptorships', 'update')).toEqual([
        ['prec-1', { startDate: '2026-10-05', endDate: '2026-12-01' }],
      ]),
    );
  });

  it('removes an orientation only after the manager confirms', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(bridge.callsTo('preceptorships', 'remove')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(bridge.callsTo('preceptorships', 'remove')).toEqual([['prec-1']]));
  });
});
