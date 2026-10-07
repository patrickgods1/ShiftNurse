// @vitest-environment jsdom
/**
 * Settings › Pay › Rates: a nurse on the VA's 72/80 or Baylor plan is paid by a different hourly
 * divisor, and the page says so beside her own rate.
 */

import { isoDate, type Nurse, type PayRate } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { PayRatesSection } from './rates.js';

const nurse = (id: string, last: string, kind?: Nurse['scheduleKind']): Nurse => ({
  id,
  unitId: 'u-1',
  employeeId: id,
  firstName: 'A',
  lastName: last,
  role: 'RN',
  employmentType: 'full_time',
  fte: 0.9,
  contractedHoursPerPeriod: 72,
  seniorityDate: isoDate('2020-01-01'),
  isChargeEligible: false,
  isNovice: false,
  isFloatEligible: false,
  active: true,
  ...(kind ? { scheduleKind: kind } : {}),
});

const rate = (id: string, nurseId: string): PayRate => ({
  id,
  nurseId,
  role: null,
  hourlyRate: 40,
  effectiveFrom: isoDate('2020-01-01'),
});

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('hourly-rate divisor note in Settings › Pay', () => {
  it('names the statutory divisor for 72/80 and Baylor nurses and nobody else', async () => {
    bridge.respond('cost', 'payRates', [rate('r1', 'n1'), rate('r2', 'n2'), rate('r3', 'n3')]);
    renderWithApp(
      <PayRatesSection
        unitId="u-1"
        nurses={[
          nurse('n1', 'Adams', 'va_72_80'),
          nurse('n2', 'Baker', 'va_baylor'),
          nurse('n3', 'Cole'),
        ]}
      />,
    );
    expect(
      await screen.findByText(/annual salary ÷ 1,872 \(38 U\.S\.C\. § 7456A\(b\)\(2\)\)/),
    ).toBeTruthy();
    expect(screen.getByText(/annual salary ÷ 1,248 \(38 U\.S\.C\. § 7456\(b\)\)/)).toBeTruthy();
    expect(screen.getAllByText(/annual salary ÷/)).toHaveLength(2);
  });
});
