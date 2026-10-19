// @vitest-environment jsdom
/**
 * Settings › Solver picks the unit's default method. After Save the saved settings refetch; the
 * manager must still be told it saved, and told which method Generate really uses while the
 * chosen one is not installed.
 */

import { isoDate, type SolverSettings, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SolverAvailability } from '../../../../shared/api.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import SolverPanel from './solver.js';

const unit: Unit = {
  id: 'unit-1',
  name: '3 West ICU',
  unitType: 'ICU',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const everySolver: SolverAvailability[] = [
  { id: 'hybrid', available: true },
  { id: 'sa-lns', available: true },
  { id: 'cp-sat', available: true },
];

describe('Settings › Solver', () => {
  it('says Saved after the default solver changes', async () => {
    let settings: SolverSettings = { solverId: 'hybrid' };
    bridge.respond('solverSettings', 'get', () => settings);
    bridge.respond('solverSettings', 'save', (_unitId, next) => {
      settings = next;
      return next;
    });
    bridge.respond('solver', 'available', everySolver);
    renderWithApp(<SolverPanel />, { unit });

    fireEvent.click(await screen.findByTestId('solver-option-sa-lns'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(bridge.callsTo('solverSettings', 'save')).toEqual([['unit-1', { solverId: 'sa-lns' }]]);
  });

  it('says which solver Generate falls back to while the chosen one is missing', async () => {
    bridge.respond('solverSettings', 'get', { solverId: 'hybrid' });
    bridge.respond('solver', 'available', [
      { id: 'hybrid', available: false, reason: 'The OR-Tools runner is not installed.' },
      { id: 'sa-lns', available: true },
      { id: 'cp-sat', available: false, reason: 'The OR-Tools runner is not installed.' },
    ]);
    renderWithApp(<SolverPanel />, { unit });

    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Generate will fall back to Fastest');
  });
});
