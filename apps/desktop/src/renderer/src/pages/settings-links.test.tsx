// @vitest-environment jsdom
/**
 * The two behaviours that make Settings reachable from elsewhere: a rule link lands on that
 * rule's card, and leaving a tab with unsaved edits still asks first.
 */

import {
  ALL_RULES,
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type RuleSet,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedChanges } from '../components/unsaved-changes.js';
import { installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import SettingsPage from './settings.js';

vi.mock('./settings/unit.js', () => ({
  default: function DirtyUnit() {
    useUnsavedChanges('the unit', true);
    return <p>unit panel</p>;
  },
}));
vi.mock('./settings/pay.js', () => ({ default: () => <p>pay panel</p> }));

const unit = { id: 'unit-1' } as Unit;
const ruleSet: RuleSet = {
  id: 'rs-1',
  unitId: 'unit-1',
  name: 'Contract',
  version: 1,
  configs: [],
  weekendDefinition: DEFAULT_WEEKEND,
  fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
  createdAt: 0,
};

beforeEach(() => {
  installFakeBridge().respond('rules', 'getLatest', ruleSet);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Settings deep links', () => {
  it('scrolls to and highlights the rule a violation link names', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const target = ALL_RULES[1]!.id;
    renderWithApp(<SettingsPage />, { route: `/settings?tab=rules&rule=${target}`, unit });

    const card = await screen.findByTestId(`rule-card-${target}`);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.instances[0]).toBe(card);
    expect(card.className).toContain('ring-accent');
    expect(screen.getByTestId(`rule-card-${ALL_RULES[0]!.id}`).className).not.toContain(
      'ring-accent',
    );
  });

  it('asks before leaving a tab with unsaved changes, and stays if the manager declines', async () => {
    renderWithApp(<SettingsPage />, { route: '/settings', unit });
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay' }));
    expect(await screen.findByText('Discard unsaved changes to the unit?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Discard unsaved changes/)).toBeNull());
    expect(screen.getByRole('tab', { name: 'Unit' }).getAttribute('aria-selected')).toBe('true');
  });
});
