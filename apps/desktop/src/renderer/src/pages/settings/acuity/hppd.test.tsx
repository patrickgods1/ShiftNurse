// @vitest-environment jsdom
/**
 * A unit that skipped the acuity step has no HPPD target. The screen must let her type the first
 * one: the query used to reject the undefined answer, leaving Save disabled with no message.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configKeys } from '../../../api-config.js';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { HppdSection } from './hppd.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const input = () => document.getElementById('hppd-target') as HTMLInputElement;

describe('the HPPD target in Settings', () => {
  it('sets a first HPPD target on a unit that has none', async () => {
    bridge.respond('acuity', 'hppd', null);
    bridge.respond('acuity', 'setHppd', { id: 'h-1', unitId: 'unit-1', targetHours: 8.5 });
    renderWithApp(<HppdSection unitId="unit-1" />);
    await screen.findByText('No target set yet.');
    fireEvent.change(input(), { target: { value: '8.5' } });
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.submit(input().form!);
    await waitFor(() => expect(bridge.callsTo('acuity', 'setHppd')).toEqual([['unit-1', 8.5]]));
  });

  it('shows the saved target and keeps Save off until it changes', async () => {
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 8 });
    renderWithApp(<HppdSection unitId="unit-1" />);
    await waitFor(() => expect(input().value).toBe('8'));
    expect(save().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: '8.0' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: '8.5' } });
    expect(save().disabled).toBe(false);
  });

  it('says so when the target cannot be loaded', async () => {
    bridge.fail('acuity', 'hppd', new Error('Database is locked'));
    renderWithApp(<HppdSection unitId="unit-1" />);
    expect(await screen.findByText('Could not load the HPPD target')).toBeTruthy();
    expect(screen.getByText('Database is locked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('refuses a target of zero', async () => {
    bridge.respond('acuity', 'hppd', null);
    renderWithApp(<HppdSection unitId="unit-1" />);
    await screen.findByText('No target set yet.');
    fireEvent.change(input(), { target: { value: '0' } });
    expect(screen.getByText('Enter a number above 0.')).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

  it('keeps what she is typing when the target is refetched with a different value', async () => {
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 8 });
    const { queryClient } = renderWithApp(<HppdSection unitId="unit-1" />);
    await waitFor(() => expect(input().value).toBe('8'));
    fireEvent.change(input(), { target: { value: '9.5' } });
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 7 });
    await queryClient.invalidateQueries({ queryKey: configKeys.hppdTarget('unit-1') });
    expect(bridge.callsTo('acuity', 'hppd')).toHaveLength(2);
    expect(input().value).toBe('9.5');
  });

  it('shows a target changed elsewhere after she has saved one', async () => {
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 8 });
    bridge.respond('acuity', 'setHppd', { id: 'h-1', unitId: 'unit-1', targetHours: 9 });
    const { queryClient } = renderWithApp(<HppdSection unitId="unit-1" />);
    await waitFor(() => expect(input().value).toBe('8'));
    fireEvent.change(input(), { target: { value: '9' } });
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 9 });
    fireEvent.submit(input().form!);
    await screen.findByText('Saved.');
    // A restore replaces the file; the idle field must follow it.
    bridge.respond('acuity', 'hppd', { id: 'h-1', unitId: 'unit-1', targetHours: 6 });
    await queryClient.invalidateQueries({ queryKey: configKeys.hppdTarget('unit-1') });
    await waitFor(() => expect(input().value).toBe('6'));
  });
});
