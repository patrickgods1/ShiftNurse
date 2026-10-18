// @vitest-environment jsdom
/**
 * Entering the real census on a shift card. A unit with no acuity tiers has nothing to split
 * the census across, so its total must save on its own; a unit with tiers still has to account
 * for every patient.
 */

import type { TodayShiftView } from '@shared/api.js';
import type { AcuityTier } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CensusEntry } from './census-entry.js';

const shift = {
  date: '2026-10-05',
  shiftType: { id: 'st-d' },
  census: { id: 'c1', projectedCensus: 20, acuityMix: {} },
} as unknown as TodayShiftView;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('entering the real census on a shift card', () => {
  it('saves the real census on a unit with no acuity tiers', async () => {
    bridge.respond('acuity', 'tiers', []);
    bridge.respond('census', 'recordActual', {} as never);
    renderWithApp(<CensusEntry unitId="unit-1" shift={shift} />);
    const save = (await screen.findByRole('button', { name: 'Save census' })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(save);
    await waitFor(
      () => expect(bridge.callsTo('census', 'recordActual')).toEqual([['c1', 20, {}]]),
      {
        timeout: 5000,
      },
    );
  });

  it('still wants the tiers to add up on a unit that has them', async () => {
    bridge.respond('acuity', 'tiers', [{ id: 't1', name: 'Tier 1' } as AcuityTier]);
    renderWithApp(<CensusEntry unitId="unit-1" shift={shift} />);
    expect(
      await screen.findByText('Tiers must add up to 20', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save census' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('will not save before the unit’s tiers have arrived', async () => {
    let release: (t: AcuityTier[]) => void = () => undefined;
    bridge.respond(
      'acuity',
      'tiers',
      () =>
        new Promise<AcuityTier[]>((resolve) => {
          release = resolve;
        }) as never,
    );
    bridge.respond('census', 'recordActual', {} as never);
    renderWithApp(<CensusEntry unitId="unit-1" shift={shift} />);
    const save = (await screen.findByRole('button', {
      name: 'Save census',
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest('form')!);
    expect(bridge.callsTo('census', 'recordActual')).toEqual([]);

    release([{ id: 't1', name: 'Tier 1' } as AcuityTier]);
    expect(
      await screen.findByText('Tiers must add up to 20', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(bridge.callsTo('census', 'recordActual')).toEqual([]);
  });
});
