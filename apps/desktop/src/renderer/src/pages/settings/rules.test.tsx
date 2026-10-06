// @vitest-environment jsdom
/**
 * The rules editor writes the contract every schedule is judged by. These tests pin what a
 * manager's edit puts on the wire: a new version carrying exactly their change, nothing saved
 * while a field is invalid, and Discard going back to the version that was loaded.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  DEFAULT_WEEKEND,
  type RuleConfig,
  type RuleSet,
  type Unit,
} from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import RulesPanel from './rules.js';

const unit = { id: 'unit-1' } as Unit;
const REST = 'min-rest-between-shifts';
const loaded: RuleSet = {
  id: 'rs-1',
  unitId: 'unit-1',
  name: 'Contract',
  version: 3,
  configs: [],
  weekendDefinition: DEFAULT_WEEKEND,
  fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
  createdAt: 0,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('rules', 'getLatest', loaded);
  // Like main: a save inserts version 4, which is then the latest.
  bridge.respond('rules', 'save', (unitId, name, configs) => {
    const saved = { ...loaded, unitId, name, configs, version: 4 };
    bridge.respond('rules', 'getLatest', saved);
    return saved;
  });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

async function renderRules() {
  renderWithApp(<RulesPanel />, { unit });
  return screen.findByTestId(`rule-card-${REST}`);
}

const saveButton = () => screen.getByRole('button', { name: /Save as version|Saving/ });
const discardButton = () => screen.getByRole('button', { name: 'Discard' });

function restInput(card: HTMLElement) {
  return card.querySelector(`#${REST}-minRestHours`) as HTMLInputElement;
}

/**
 * The name field by its id. `screen.getByLabelText` resolves every label on a form of a few
 * hundred fields, which took the discard test past its limit on a Windows runner.
 */
function nameInput(): HTMLInputElement {
  const input = document.getElementById('rule-set-name');
  if (!(input instanceof HTMLInputElement)) throw new Error('no rule set name field');
  return input;
}

function savedConfig(ruleId: string): RuleConfig {
  const [call] = bridge.callsTo('rules', 'save');
  return call![2].find((c) => c.ruleId === ruleId)!;
}

describe('editing the contract rules', () => {
  it('offers nothing to save until the manager changes something', async () => {
    await renderRules();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect((discardButton() as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().textContent).toBe('Save as version 4');
  });

  it('saves a new version carrying the longer rest the manager typed', async () => {
    const card = await renderRules();
    fireEvent.change(restInput(card), { target: { value: '12' } });

    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(bridge.callsTo('rules', 'save')).toHaveLength(1));
    const [unitId, name, , weekend, weights] = bridge.callsTo('rules', 'save')[0]!;
    expect([unitId, name]).toEqual(['unit-1', 'Contract']);
    expect(weekend).toEqual(DEFAULT_WEEKEND);
    expect(weights).toEqual(DEFAULT_FAIRNESS_WEIGHTS);
    expect(savedConfig(REST).params.minRestHours).toBe(12);
    expect(savedConfig(REST).enabled).toBe(true);
    // The saved version becomes the loaded one: nothing left to save, next save is version 5.
    expect(await screen.findByText('Saved version 4')).toBeTruthy();
    await waitFor(() => expect(saveButton().textContent).toBe('Save as version 5'));
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(restInput(card).value).toBe('12');
  });

  it('refuses to save while minimum rest is cleared, and says which field to fix', async () => {
    const card = await renderRules();
    fireEvent.change(restInput(card), { target: { value: '' } });

    expect(
      await screen.findByText(
        /Fix before saving:.*Minimum rest between shifts: Minimum rest \(hours\)/,
      ),
    ).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(bridge.callsTo('rules', 'save')).toHaveLength(0);

    // Typing a real number again clears the block.
    fireEvent.change(restInput(card), { target: { value: '9' } });
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('puts the loaded values back when the manager discards', async () => {
    const card = await renderRules();
    fireEvent.change(restInput(card), { target: { value: '14' } });
    fireEvent.change(nameInput(), { target: { value: 'Draft' } });
    expect(restInput(card).value).toBe('14');

    fireEvent.click(discardButton());

    await waitFor(() => expect(restInput(card).value).toBe('10'));
    expect(nameInput().value).toBe('Contract');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.callsTo('rules', 'save')).toHaveLength(0);
  });

  it('saves a rule the manager switched off as disabled, keeping its settings', async () => {
    const card = await renderRules();
    fireEvent.click(within(card).getByLabelText('Enabled'));
    expect(within(card).getByText(/Its settings are kept/)).toBeTruthy();
    fireEvent.click(saveButton());

    await waitFor(() => expect(bridge.callsTo('rules', 'save')).toHaveLength(1));
    expect(savedConfig(REST).enabled).toBe(false);
    expect(savedConfig(REST).params.minRestHours).toBe(10);
  });

  it('saves a hard rule the manager relaxed to soft as a severity override', async () => {
    const card = await renderRules();
    fireEvent.change(card.querySelector(`#${REST}-severity`) as HTMLSelectElement, {
      target: { value: 'soft' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(bridge.callsTo('rules', 'save')).toHaveLength(1));
    expect(savedConfig(REST).severityOverride).toBe('soft');
  });

  it("drops the override again when the manager picks the rule's own severity back", async () => {
    const card = await renderRules();
    const severity = card.querySelector(`#${REST}-severity`) as HTMLSelectElement;
    fireEvent.change(severity, { target: { value: 'soft' } });
    fireEvent.change(severity, { target: { value: 'hard' } });

    // Back to what was loaded, so there is nothing to save.
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(true));
  });
});

describe('explaining a loosened protected rule', () => {
  const OT = 'no-mandatory-overtime';
  const vaUnit = { id: 'unit-1', jurisdiction: 'US-VA' } as Unit;

  it('holds Save until a reason is typed when the ban on mandatory overtime is switched off', async () => {
    bridge.respond('rules', 'getLatest', {
      ...loaded,
      configs: [{ ruleId: OT, enabled: true, params: {} }],
    });
    renderWithApp(<RulesPanel />, { unit: vaUnit });
    const card = await screen.findByTestId(`rule-card-${OT}`);
    expect(screen.queryByTestId('rules-reason')).toBeNull();

    fireEvent.click(within(card).getByLabelText('Enabled'));
    const reason = await screen.findByTestId('rules-reason');
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(reason, { target: { value: 'Union side letter' } });
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(saveButton());

    await waitFor(() => expect(bridge.callsTo('rules', 'save')).toHaveLength(1));
    expect(bridge.callsTo('rules', 'save')[0]![5]).toBe('Union side letter');
  });

  it('asks for no reason when an unprotected rule is switched off', async () => {
    const card = await renderRules();
    fireEvent.click(within(card).getByLabelText('Enabled'));
    await screen.findByText('Unsaved changes');
    expect(screen.queryByTestId('rules-reason')).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('names the protected rule and says it is switched off', async () => {
    bridge.respond('rules', 'getLatest', {
      ...loaded,
      configs: [{ ruleId: OT, enabled: true, params: {} }],
    });
    renderWithApp(<RulesPanel />, { unit: vaUnit });
    const card = await screen.findByTestId(`rule-card-${OT}`);
    fireEvent.click(within(card).getByLabelText('Enabled'));
    expect((await screen.findByTestId('rules-reason-section')).textContent).toMatch(
      /No mandatory overtime is switched off/,
    );
  });

  it('names the protected rule and says it is made advisory when softened', async () => {
    bridge.respond('rules', 'getLatest', {
      ...loaded,
      configs: [{ ruleId: OT, enabled: true, params: {} }],
    });
    renderWithApp(<RulesPanel />, { unit: vaUnit });
    const card = await screen.findByTestId(`rule-card-${OT}`);
    fireEvent.change(card.querySelector(`#${OT}-severity`) as HTMLSelectElement, {
      target: { value: 'soft' },
    });
    expect((await screen.findByTestId('rules-reason-section')).textContent).toMatch(
      /No mandatory overtime is made advisory/,
    );
  });

  it('starts the next change with an empty reason after one was saved', async () => {
    const enabled = { ruleId: OT, enabled: true, params: {} };
    bridge.respond('rules', 'getLatest', { ...loaded, configs: [enabled] });
    // The save lands as a version where the rule is on again, so the next switch-off is a new loosening.
    bridge.respond('rules', 'save', () => {
      const saved = { ...loaded, version: 4, configs: [enabled] };
      bridge.respond('rules', 'getLatest', saved);
      return saved;
    });
    renderWithApp(<RulesPanel />, { unit: vaUnit });
    const card = await screen.findByTestId(`rule-card-${OT}`);
    fireEvent.click(within(card).getByLabelText('Enabled'));
    fireEvent.change(await screen.findByTestId('rules-reason'), {
      target: { value: 'Union side letter' },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(bridge.callsTo('rules', 'save')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('rules-reason')).toBeNull());

    const again = await screen.findByTestId(`rule-card-${OT}`);
    fireEvent.click(within(again).getByLabelText('Enabled'));
    expect(((await screen.findByTestId('rules-reason')) as HTMLTextAreaElement).value).toBe('');
  });
});
