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

const person = (id: string, firstName: string, lastName: string, more: Partial<Nurse>) =>
  ({ id, firstName, lastName, active: true, ...more }) as Nurse;
const nina = person('n-nina', 'Nina', 'Park', { role: 'RN', isNovice: true });
const vera = person('n-vera', 'Vera', 'Lund', { role: 'RN', isNovice: false });
const omar = person('n-omar', 'Omar', 'Diaz', { role: 'RN', isNovice: false });
const cora = person('n-cora', 'Cora', 'Reyes', { role: 'CNA', isNovice: false });
const ned = person('n-ned', 'Ned', 'Moss', { role: 'RN', isNovice: true });
const cleo = person('n-cleo', 'Cleo', 'Hart', { role: 'CNA', isNovice: true });

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
  renderWithApp(
    <OrientationSection unitId="unit-1" nurses={[nina, vera, omar, cora, ned, cleo]} />,
  );

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

  it('offers only experienced RNs to precept a new RN', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByTestId('orientation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Orientee'), { target: { value: 'n-nina' } });
    expect(dialog.getByLabelText('Vera Lund')).toBeTruthy();
    expect(dialog.getByLabelText('Omar Diaz')).toBeTruthy();
    expect(dialog.queryByLabelText(/^Cora /)).toBeNull();
    expect(dialog.queryByLabelText(/^Ned /)).toBeNull();
  });

  it('asks for the orientee before offering any preceptor', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByTestId('orientation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Choose the orientee first.')).toBeTruthy();
    expect(dialog.queryAllByRole('checkbox')).toEqual([]);
  });

  it('drops an aide the manager ticked once the orientee becomes a new RN', async () => {
    renderSection();
    await screen.findByText('Nina Park with Vera Lund');
    fireEvent.click(screen.getByTestId('orientation-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Orientee'), { target: { value: 'n-cleo' } });
    fireEvent.click(dialog.getByLabelText('Cora Reyes'));
    fireEvent.click(dialog.getByLabelText('Vera Lund'));
    fireEvent.change(dialog.getByLabelText('Orientee'), { target: { value: 'n-nina' } });
    expect(dialog.queryByLabelText('Cora Reyes')).toBeNull();
    fireEvent.change(dialog.getByLabelText('First day'), { target: { value: '2026-10-05' } });
    fireEvent.change(dialog.getByLabelText('Last day'), { target: { value: '2026-11-15' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('preceptorships', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            orienteeId: 'n-nina',
            preceptorIds: ['n-vera'],
            startDate: '2026-10-05',
            endDate: '2026-11-15',
          },
        ],
      ]),
    );
  });

  it('still shows the preceptor of an orientation recorded before the rule when editing it', async () => {
    bridge.respond('preceptorships', 'list', [{ ...record, id: 'prec-2', preceptorId: 'n-cora' }]);
    renderSection();
    await screen.findByText('Nina Park with Cora Reyes');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Nina Park’s orientation with Cora Reyes, Oct 5, 2026 to Nov 15, 2026',
      }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    expect((dialog.getByLabelText('Cora Reyes') as HTMLInputElement).checked).toBe(true);
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
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Edit Nina Park’s orientation with Vera Lund, Oct 5, 2026 to Nov 15, 2026',
      }),
    );
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
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove Nina Park’s orientation with Vera Lund, Oct 5, 2026 to Nov 15, 2026',
      }),
    );
    expect(bridge.callsTo('preceptorships', 'remove')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(bridge.callsTo('preceptorships', 'remove')).toEqual([['prec-1']]));
  });
});
