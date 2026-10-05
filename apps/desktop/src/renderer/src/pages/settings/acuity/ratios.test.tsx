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
