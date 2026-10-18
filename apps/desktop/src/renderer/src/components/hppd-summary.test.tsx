// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '../query-client.js';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { TipProvider } from './field-help.js';
import { againstTarget, describeAgainstTarget, HppdSummary } from './hppd-summary.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function show(hppd: number | undefined, targetHours: number | undefined) {
  bridge.respond('census', 'hppd', {
    hppd,
    targetHours,
    days: [],
    nursingHours: 100,
    patientDays: 12.4,
    unmeasuredDates: [],
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TipProvider>
        <HppdSummary periodId="p1" title="Scheduled HPPD" />
      </TipProvider>
    </QueryClientProvider>,
  );
}

describe('HPPD against the target', () => {
  it('8.05 hours against a target of 8 reads "0.1 over target" and is coloured as over', async () => {
    // 8.05 - 8 = 0.05 (0.0500000000000007 in floating point); x10 = 0.5000..07 rounds to 1; /10 = 0.1.
    expect(againstTarget(8.05, 8)).toEqual({ kind: 'over', amount: 0.1 });
    show(8.05, 8);
    expect((await screen.findByText('8.1')).className).toContain('text-warn');
    expect(screen.getByText(/0\.1 over target/)).toBeTruthy();
  });

  it('7.54 against 7.5 is on target in the normal colour', async () => {
    expect(againstTarget(7.54, 7.5).kind).toBe('on');
    show(7.54, 7.5);
    const big = await screen.findByText('7.5');
    expect(big.className).not.toContain('text-warn');
  });

  it('7.45 against 7.5 is on target', () => {
    // -0.05 x 10 = -0.4999..., which rounds to -0.
    expect(againstTarget(7.45, 7.5).kind).toBe('on');
    expect(describeAgainstTarget(7.45, 7.5)).toBe('on target');
  });

  it('says to enter a census when none covers the period', async () => {
    show(undefined, 8);
    expect(await screen.findByText(/No census forecast covers this period yet/)).toBeTruthy();
  });
});
