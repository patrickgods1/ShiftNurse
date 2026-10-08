// @vitest-environment jsdom
/**
 * The assisted first-run guide is a new manager's first hour. These tests pin where it resumes,
 * what Continue and Skip record, and what a starting-point preset sends, so a step that
 * silently stops saving progress is caught before someone redoes their unit setup.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  isoDate,
  type RuleSet,
  SETUP_STEPS,
  type SetupState,
  type SetupStepId,
  type ShiftType,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { AssistedSetup } from './assisted.js';
import { STEP_TITLES } from './steps.js';

const unit: Unit = {
  id: 'unit-1',
  name: '4 West',
  unitType: 'Medical-Surgical',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-01-04'),
};
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
const day12 = {
  id: 'st-d12',
  unitId: 'unit-1',
  name: 'Day 12',
  abbreviation: 'D12',
  startTime: '07:00',
  durationHours: 12,
  isNight: false,
  isOnCall: false,
  active: true,
} as ShiftType;

function stateAt(step: SetupStepId, skippedSteps: SetupStepId[] = []): SetupState {
  return {
    mode: 'assisted',
    status: 'in_progress',
    currentStep: step,
    skippedSteps,
    startedAt: 0,
    completedAt: null,
  };
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
  bridge.respond('rules', 'getLatest', ruleSet);
  bridge.respond('setup', 'applyPreset', { created: 2, updated: 0, unchanged: 1 });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderAt(step: SetupStepId, skipped: SetupStepId[] = []) {
  return renderWithApp(<AssistedSetup state={stateAt(step, skipped)} />, { unit });
}

describe('the assisted setup guide', () => {
  it('opens on the step the manager had reached, not the first one', async () => {
    renderAt('holidays');
    expect(await screen.findByRole('heading', { level: 1, name: 'Holidays' })).toBeTruthy();
    const current = screen
      .getByRole('navigation', { name: 'Setup steps' })
      .querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain('Holidays');
  });

  it('shows the steps in order and marks the ones left for later as skipped', async () => {
    renderAt('pay', ['coverage']);
    const nav = await screen.findByRole('navigation', { name: 'Setup steps' });
    const items = [...nav.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toHaveLength(SETUP_STEPS.length);
    expect(items[0]).toBe('1. State and contract law');
    expect(items[1]).toBe('2. Shift types');
    expect(items[2]).toBe('3. Staffing floors(skipped)');
  });

  it('shows the shift-pattern starting point above the shift-types editor', async () => {
    renderAt('shift-types');
    expect(await screen.findByText('Start from a common shift pattern')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add these shifts' })).toBeTruthy();
  });

  it('shows the acuity presets for the unit, the holiday list and the rules editor on their steps', async () => {
    renderAt('acuity');
    expect(await screen.findByText('Start from typical ratios for your kind of unit')).toBeTruthy();
    cleanup();
    renderAt('holidays');
    expect(await screen.findByText('Add the US federal holidays')).toBeTruthy();
    cleanup();
    renderAt('rules');
    expect(await screen.findByTestId('rules-panel')).toBeTruthy();
  });

  it('adds the chosen shift pattern when Continue is pressed on an empty step, then moves on', async () => {
    renderAt('shift-types');
    const continueButton = await screen.findByTestId('setup-continue');
    await waitFor(() => expect(continueButton.textContent).toBe('Add these shifts and continue'));
    fireEvent.click(continueButton);

    await waitFor(() => expect(bridge.callsTo('setup', 'advance')).toHaveLength(1));
    expect(bridge.callsTo('setup', 'applyPreset')).toEqual([
      ['unit-1', { kind: 'shift-pattern', pattern: '12h' }],
    ]);
    expect(bridge.callsTo('setup', 'advance')[0]).toEqual([
      { from: 'shift-types', to: 'coverage', skipped: false },
    ]);
  });

  it('sends the pattern the manager picked, not the default', async () => {
    renderAt('shift-types');
    const radios = await screen.findAllByRole('radio');
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Add these shifts' }));

    await waitFor(() => expect(bridge.callsTo('setup', 'applyPreset')).toHaveLength(1));
    const [, preset] = bridge.callsTo('setup', 'applyPreset')[0]!;
    expect(preset).toEqual({ kind: 'shift-pattern', pattern: expect.not.stringMatching(/^12h$/) });
    expect(await screen.findByText('Done: 2 added, 1 already there.')).toBeTruthy();
    // The button applies the preset only; the guide stays where it is.
    expect(bridge.callsTo('setup', 'advance')).toHaveLength(0);
  });

  it('applies the recommended contract rules from the rules step', async () => {
    renderAt('rules');
    fireEvent.click(await screen.findByRole('button', { name: 'Use recommended rules' }));
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyPreset')).toEqual([['unit-1', { kind: 'rules' }]]),
    );
  });

  it('adds holidays for this year and next from the holidays step', async () => {
    renderAt('holidays');
    fireEvent.click(
      await screen.findByRole('button', { name: /Add holidays for \d{4} and \d{4}/ }),
    );
    await waitFor(() => expect(bridge.callsTo('setup', 'applyPreset')).toHaveLength(1));
    const [, preset] = bridge.callsTo('setup', 'applyPreset')[0]!;
    expect(preset).toMatchObject({ kind: 'holidays' });
    const years = (preset as { years: number[] }).years;
    expect(years[1]).toBe(years[0]! + 1);
  });

  it('starts the acuity step from the preset for the unit type', async () => {
    renderAt('acuity');
    fireEvent.click(await screen.findByRole('button', { name: 'Add these tiers and ratios' }));
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyPreset')).toEqual([
        ['unit-1', { kind: 'acuity', preset: 'med-surg' }],
      ]),
    );
  });

  it('keeps the base-rates button off until a rate is typed, then sends only the roles filled in', async () => {
    renderAt('pay');
    const apply = await screen.findByRole('button', { name: 'Save base rates' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('RN $/hour'), { target: { value: '48.5' } });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'applyPreset')).toEqual([
        ['unit-1', { kind: 'base-rates', rates: { RN: 48.5 } }],
      ]),
    );
  });

  it('moves to the next step without a skip when the step already has what it needs', async () => {
    bridge.respond('shiftTypes', 'list', [day12]);
    renderAt('shift-types');
    const continueButton = await screen.findByTestId('setup-continue');
    await waitFor(() => expect(continueButton.textContent).toBe('Continue'));
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'shift-types', to: 'coverage', skipped: false }],
      ]),
    );
    expect(bridge.callsTo('setup', 'applyPreset')).toHaveLength(0);
  });

  it('records the step as skipped when the manager chooses Skip for now', async () => {
    renderAt('coverage');
    fireEvent.click(await screen.findByTestId('setup-skip'));
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'coverage', to: 'acuity', skipped: true }],
      ]),
    );
    expect(bridge.callsTo('setup', 'applyPreset')).toHaveLength(0);
  });

  it('goes back one step without marking the step it left as skipped', async () => {
    renderAt('acuity');
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'acuity', to: 'coverage', skipped: false }],
      ]),
    );
  });

  it('lets a manager on a fresh unit move past state law without choosing, as a skip', async () => {
    renderAt('state');
    expect(await screen.findByLabelText('State or federal law')).toBeTruthy();
    const continueButton = screen.getByTestId('setup-continue');
    expect(continueButton.textContent).toBe('Continue');
    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'state', to: 'shift-types', skipped: true }],
      ]),
    );
    expect(bridge.callsTo('setup', 'applyJurisdiction')).toHaveLength(0);
  });

  it('applies the chosen state on Continue without asking again, then moves on', async () => {
    bridge.respond('setup', 'applyJurisdiction', { created: 1, updated: 0, unchanged: 0 });
    renderAt('state');
    fireEvent.change(await screen.findByLabelText('State or federal law'), {
      target: { value: 'CA' },
    });
    const continueButton = screen.getByTestId('setup-continue');
    await waitFor(() => expect(continueButton.textContent).toBe('Apply California and continue'));
    fireEvent.click(continueButton);

    await waitFor(() => expect(bridge.callsTo('setup', 'advance')).toHaveLength(1));
    expect(bridge.callsTo('setup', 'applyJurisdiction')).toEqual([['unit-1', 'CA', {}]]);
    expect(screen.queryByText(/never loosens/)).toBeNull();
    expect(bridge.callsTo('setup', 'advance')[0]).toEqual([
      { from: 'state', to: 'shift-types', skipped: false },
    ]);
  });

  it('moves on from state law without reapplying when the unit already has a state', async () => {
    renderWithApp(<AssistedSetup state={stateAt('state')} />, {
      unit: { ...unit, jurisdiction: 'CA' },
    });
    const continueButton = await screen.findByTestId('setup-continue');
    await waitFor(() => expect(continueButton.textContent).toBe('Continue'));
    fireEvent.click(continueButton);
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'state', to: 'shift-types', skipped: false }],
      ]),
    );
    expect(bridge.callsTo('setup', 'applyJurisdiction')).toHaveLength(0);
  });

  it('keeps the state-law picker off the acuity step now that it has its own', async () => {
    renderAt('acuity');
    expect(await screen.findByText('Start from typical ratios for your kind of unit')).toBeTruthy();
    expect(screen.queryByTestId('state-law')).toBeNull();
  });

  it('shows the unit policies, leave and requests editors on their own steps', async () => {
    renderAt('unit');
    expect(await screen.findByTestId('unit-policies-form')).toBeTruthy();
    expect(screen.queryByTestId('state-law')).toBeNull();
    expect(screen.queryByTestId('start-over')).toBeNull();
    cleanup();
    renderAt('leave');
    expect(await screen.findByTestId('leave-panel')).toBeTruthy();
    cleanup();
    renderAt('requests');
    expect(await screen.findByTestId('conflict-policy')).toBeTruthy();
    expect(await screen.findByTestId('cancellation-order')).toBeTruthy();
    expect(await screen.findByTestId('solver-settings')).toBeTruthy();
  });

  it('moves past unit policies as reviewed, not skipped, when Continue is pressed', async () => {
    renderAt('unit');
    fireEvent.click(await screen.findByTestId('setup-continue'));
    await waitFor(() =>
      expect(bridge.callsTo('setup', 'advance')).toEqual([
        [{ from: 'unit', to: 'leave', skipped: false }],
      ]),
    );
  });

  it('marks reviewed defaults as reviewed and points skipped steps to their Settings tab', async () => {
    renderAt('finish', ['leave']);
    const summary = await screen.findByTestId('setup-summary');
    const lines = [...summary.querySelectorAll('li')].map((li) => li.textContent);
    expect(lines).toContain('✓Unit policiesreviewed');
    expect(lines).toContain('✓Requests and generationreviewed');
    expect(lines).toContain('○Leaveleft for later — later in Settings › LeaveSet it up now');
    expect(lines).toContain(
      '○State and contract lawnot set up yet — later in Settings › UnitSet it up now',
    );
    expect(lines[0]).toContain('State and contract law');
  });

  it('lists what is still missing on the summary and offers to open the app', async () => {
    renderAt('finish');
    expect(await screen.findByTestId('setup-summary')).toBeTruthy();
    expect(screen.getByText(/4 West needs 3 more things before you can schedule/)).toBeTruthy();
    expect(screen.getByTestId('setup-finish')).toBeTruthy();
    expect(STEP_TITLES.finish).toBe('Summary');
  });
});
