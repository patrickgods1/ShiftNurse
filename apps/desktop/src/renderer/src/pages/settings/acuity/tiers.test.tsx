// @vitest-environment jsdom
/** Acuity tiers in Settings: one click of Create, one tier. */

import type { AcuityTier } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { AcuityTiersSection } from './tiers.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('Settings › Acuity tiers', () => {
  it('makes one tier when Create is double-clicked', async () => {
    let release: (value: AcuityTier) => void = () => {};
    bridge.respond(
      'acuity',
      'createTier',
      () => new Promise<AcuityTier>((resolve) => (release = resolve)) as unknown as AcuityTier,
    );
    renderWithApp(<AcuityTiersSection unitId="unit-1" tiers={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add tier' }));

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Stable' } });
    fireEvent.change(screen.getByLabelText('Care hours per patient day'), {
      target: { value: '4' },
    });

    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    // A real second click lands after React has rendered the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(create);

    await waitFor(() => expect(bridge.callsTo('acuity', 'createTier')).toHaveLength(1));
    expect(bridge.callsTo('acuity', 'createTier')).toHaveLength(1);
    expect(bridge.callsTo('acuity', 'createTier')[0]![0]).toEqual({
      unitId: 'unit-1',
      name: 'Stable',
      level: 1,
      careHoursPerPatientDay: 4,
    });
    release({ id: 't1', unitId: 'unit-1', name: 'Stable', level: 1, careHoursPerPatientDay: 4 });
  });
});
