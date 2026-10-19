// @vitest-environment jsdom
/**
 * A California unit sets its Title 22 ratio as licensed nurses, RNs and LVNs together, at most
 * half LVNs. What crosses IPC is the role and the share as a fraction.
 */

import type { RatioRule } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { RatioRulesSection } from './ratios.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('acuity', 'createRatioRule', (input) => ({ id: 'new', ...input }) as RatioRule);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function field(id: string): HTMLInputElement | HTMLSelectElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no field ${id}`);
  return el as HTMLInputElement | HTMLSelectElement;
}

describe('a licensed-nurse ratio in Settings', () => {
  it('asks for the RN share only for a licensed ratio, and sends it as a fraction', async () => {
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add ratio rule' }));
    expect(document.getElementById('ratio-rn-share')).toBeNull();

    fireEvent.change(field('ratio-role'), { target: { value: 'licensed' } });
    fireEvent.change(field('ratio-max'), { target: { value: '5' } });
    fireEvent.change(field('ratio-rn-share'), { target: { value: '50' } });
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    // jsdom does not submit a form for a click on its submit button; submit it as the click would.
    fireEvent.submit(create.form!);

    await waitFor(() => expect(bridge.callsTo('acuity', 'createRatioRule')).toHaveLength(1));
    expect(bridge.callsTo('acuity', 'createRatioRule')[0]![0]).toMatchObject({
      role: 'licensed',
      maxPatientsPerNurse: 5,
      minRnShare: 0.5,
    });
  });

  it('will not create a licensed ratio asking for more than all RNs', async () => {
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add ratio rule' }));
    fireEvent.change(field('ratio-role'), { target: { value: 'licensed' } });
    fireEvent.change(field('ratio-max'), { target: { value: '5' } });
    fireEvent.change(field('ratio-rn-share'), { target: { value: '120' } });
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('a ratio rule in Settings', () => {
  it('makes one ratio rule when Create is double-clicked', async () => {
    let release: (value: RatioRule) => void = () => {};
    bridge.respond(
      'acuity',
      'createRatioRule',
      () => new Promise<RatioRule>((resolve) => (release = resolve)) as unknown as RatioRule,
    );
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add ratio rule' }));
    fireEvent.change(field('ratio-max'), { target: { value: '5' } });

    const create = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(create);
    // A real second click lands after React has rendered the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(create);

    await waitFor(() => expect(bridge.callsTo('acuity', 'createRatioRule')).toHaveLength(1));
    expect(bridge.callsTo('acuity', 'createRatioRule')).toHaveLength(1);
    release({
      id: 'r1',
      unitId: 'unit-1',
      role: 'RN',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      active: true,
    });
  });

  it('keeps an RN share of a third when only the citation is edited', async () => {
    bridge.respond('acuity', 'updateRatioRule', (() => ({})) as never);
    const rule: RatioRule = {
      id: 'r1',
      unitId: 'unit-1',
      role: 'licensed',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      citation: 'old',
      minRnShare: 0.333,
      active: true,
    };
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[rule]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(field('ratio-rn-share').value).toBe('33.3');
    fireEvent.change(field('ratio-citation'), { target: { value: 'CA Title 22' } });
    fireEvent.submit((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).form!);

    await waitFor(() => expect(bridge.callsTo('acuity', 'updateRatioRule')).toHaveLength(1));
    expect(bridge.callsTo('acuity', 'updateRatioRule')[0]![0]).toEqual('r1');
    expect(bridge.callsTo('acuity', 'updateRatioRule')[0]![1]).toEqual({ citation: 'CA Title 22' });
  });

  it('drops the RN share when a licensed rule is changed to RN', async () => {
    bridge.respond('acuity', 'updateRatioRule', (() => ({})) as never);
    const rule: RatioRule = {
      id: 'r1',
      unitId: 'unit-1',
      role: 'licensed',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      minRnShare: 0.5,
      active: true,
    };
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[rule]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(field('ratio-role'), { target: { value: 'RN' } });
    fireEvent.submit((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).form!);

    await waitFor(() => expect(bridge.callsTo('acuity', 'updateRatioRule')).toHaveLength(1));
    expect(bridge.callsTo('acuity', 'updateRatioRule')[0]![1]).toEqual({
      role: 'RN',
      minRnShare: null,
    });
  });

  it('lists an RN share of a third as 33.3%, as the form shows it', async () => {
    const rule: RatioRule = {
      id: 'r1',
      unitId: 'unit-1',
      role: 'licensed',
      acuityTierId: null,
      maxPatientsPerNurse: 5,
      minRnShare: 0.333,
      active: true,
    };
    renderWithApp(<RatioRulesSection unitId="unit-1" tiers={[]} rules={[rule]} />);
    expect(await screen.findByText(/at least 33\.3% RNs/)).toBeTruthy();
  });
});
