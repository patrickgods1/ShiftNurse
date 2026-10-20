// @vitest-environment jsdom
/**
 * Settings › Conflicts holds the auto-resolve limits. A manager who saves a $200 cost limit must
 * see it was saved even though the saved policy refetches, and a cleared limit must not quietly
 * become "$0, only free fixes".
 */

import { type AutoResolvePolicy, isoDate, type Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import ConflictsPanel from './conflicts.js';

const unit: Unit = {
  id: 'unit-1',
  name: '3 West ICU',
  unitType: 'ICU',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};

let bridge: FakeBridge;
let policy: AutoResolvePolicy;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function scriptPolicy(initial: AutoResolvePolicy) {
  policy = initial;
  bridge.respond('conflicts', 'policy', () => policy);
  bridge.respond('conflicts', 'savePolicy', (_unitId, next) => {
    policy = next;
    return next;
  });
}

describe('Settings › Conflicts', () => {
  it('says Saved after the policy is saved', async () => {
    scriptPolicy({ enabled: true, maxCostDelta: 0, maxFairnessDrop: 0 });
    renderWithApp(<ConflictsPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Most added cost per resolution (dollars)'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect((await screen.findByRole('status')).textContent).toBe('Saved.');
    expect(bridge.callsTo('conflicts', 'savePolicy')).toEqual([
      ['unit-1', { enabled: true, maxCostDelta: 200, maxFairnessDrop: 0 }],
    ]);
  });

  it('does not save a cleared cost limit as zero', async () => {
    scriptPolicy({ enabled: true, maxCostDelta: 300, maxFairnessDrop: 1 });
    renderWithApp(<ConflictsPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Most added cost per resolution (dollars)'), {
      target: { value: '' },
    });
    expect(await screen.findByText('Enter a number.')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await waitFor(() => expect(bridge.callsTo('conflicts', 'savePolicy')).toHaveLength(0));
  });

  it('does not save a cleared fairness limit as zero', async () => {
    scriptPolicy({ enabled: true, maxCostDelta: 300, maxFairnessDrop: 1 });
    renderWithApp(<ConflictsPanel />, { unit });
    fireEvent.change(await screen.findByLabelText('Most drop in unit fairness score (points)'), {
      target: { value: '' },
    });
    expect(await screen.findByText('Enter a number.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save policy' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
