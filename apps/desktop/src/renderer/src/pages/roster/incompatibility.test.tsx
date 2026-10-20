// @vitest-environment jsdom
/**
 * Roster › Kept apart: a group keeps its own reason while the manager says why it changed, and
 * each button leads to exactly the payload that would cross IPC.
 */

import type { IncompatibilityGroup, Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { IncompatibilitySection } from './incompatibility.js';

const nurse = (id: string, firstName: string, lastName: string) =>
  ({ id, firstName, lastName, role: 'RN', active: true }) as Nurse;
const ana = nurse('n-ana', 'Ana', 'Ames');
const ben = nurse('n-ben', 'Ben', 'Bell');
const cy = nurse('n-cy', 'Cy', 'Cole');

const group: IncompatibilityGroup = {
  id: 'g-1',
  unitId: 'unit-1',
  name: 'Nights conflict',
  nurseIds: ['n-ana', 'n-ben'],
  maxTogether: 1,
  reason: 'Open HR investigation',
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('incompatibility', 'list', [group]);
  bridge.respond('incompatibility', 'create', group);
  bridge.respond('incompatibility', 'update', group);
  bridge.respond('incompatibility', 'remove', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderSection = () =>
  renderWithApp(<IncompatibilitySection unitId="unit-1" nurses={[ana, ben, cy]} />);

describe('keeping nurses apart on the roster', () => {
  it('will not allow as many on the floor as the group has members', async () => {
    renderSection();
    await screen.findByText('Nights conflict');
    fireEvent.click(screen.getByTestId('incompatibility-add'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.click(dialog.getByLabelText(/Ames, Ana/));
    fireEvent.click(dialog.getByLabelText(/Bell, Ben/));
    fireEvent.click(dialog.getByLabelText(/Cole, Cy/));
    fireEvent.change(dialog.getByLabelText('How many of them may be on the floor at once'), {
      target: { value: '3' },
    });
    expect(dialog.getByText('A group of 3 can allow at most 2 at once.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps why they are kept apart when only the members change', async () => {
    renderSection();
    await screen.findByText('Nights conflict');
    expect(screen.getByText('Reason: Open HR investigation')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nights conflict, Until removed' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByLabelText(/Cole, Cy/));
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Cy joined the rotation' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('incompatibility', 'update')).toEqual([
        [
          'g-1',
          {
            name: 'Nights conflict',
            nurseIds: ['n-ana', 'n-ben', 'n-cy'],
            maxTogether: 1,
            startsOn: null,
            endsOn: null,
          },
          'Cy joined the rotation',
        ],
      ]),
    );
    // toEqual lets an undefined key through; the basis must not be in the patch at all.
    const patch = bridge.callsTo('incompatibility', 'update')[0]![1] as object;
    expect(Object.keys(patch).includes('reason')).toBe(false);
  });

  it('rewrites why they are kept apart when the manager edits it', async () => {
    renderSection();
    await screen.findByText('Nights conflict');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nights conflict, Until removed' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Why they are kept apart'), {
      target: { value: 'Restraining order on file' },
    });
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Wording' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.callsTo('incompatibility', 'update')).toHaveLength(1));
    const call = bridge.callsTo('incompatibility', 'update')[0]!;
    expect(call[1]).toMatchObject({ reason: 'Restraining order on file' });
    expect(call[2]).toBe('Wording');
  });

  it('removes a group only once a reason for the change is given', async () => {
    renderSection();
    await screen.findByText('Nights conflict');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Nights conflict, Until removed' }));
    const dialog = within(await screen.findByRole('dialog'));
    const remove = dialog.getByRole('button', { name: 'Remove group' }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText('Why are you changing it?'), {
      target: { value: 'Resolved' },
    });
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    await waitFor(() =>
      expect(bridge.callsTo('incompatibility', 'remove')).toEqual([['g-1', 'Resolved']]),
    );
  });
});
