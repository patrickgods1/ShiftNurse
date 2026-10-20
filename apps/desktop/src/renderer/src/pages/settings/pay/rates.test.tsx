// @vitest-environment jsdom
/**
 * Settings › Pay › Rates: a nurse on the VA's 72/80 or Baylor plan is paid by a different hourly
 * divisor, and the page says so beside her own rate.
 */

import { isoDate, type Nurse, type PayRate } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
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

const namedNurse = (id: string, employeeId: string): Nurse => ({
  ...nurse(id, 'Garcia'),
  employeeId,
  firstName: 'Maria',
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

describe('pay rate list in Settings › Pay', () => {
  it('shows both nurses called Maria Garcia, each with her own rate', async () => {
    bridge.respond('cost', 'payRates', [
      { ...rate('r1', 'n1'), hourlyRate: 50, effectiveFrom: isoDate('2026-01-01') },
      { ...rate('r2', 'n2'), hourlyRate: 62, effectiveFrom: isoDate('2026-01-01') },
    ]);
    renderWithApp(
      <PayRatesSection
        unitId="u-1"
        nurses={[namedNurse('n1', 'E1042'), namedNurse('n2', 'E2210')]}
      />,
    );
    const first = (await screen.findByText('Garcia, Maria (E1042)')).closest('tr')!;
    const second = screen.getByText('Garcia, Maria (E2210)').closest('tr')!;
    expect(first.textContent).toContain('$50.00');
    expect(second.textContent).toContain('$62.00');
    expect(screen.queryByText(/^\+\d+ earlier$/)).toBeNull();
  });

  it('says nothing matches when the search finds no rate', async () => {
    bridge.respond('cost', 'payRates', [
      { id: 'r1', nurseId: null, role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2020-01-01') },
    ]);
    renderWithApp(<PayRatesSection unitId="u-1" nurses={[]} />);
    const search = await screen.findByLabelText('Find a rate by nurse or role');
    fireEvent.change(search, { target: { value: 'zz' } });
    expect(screen.getByText('No rates match “zz”.')).toBeTruthy();
  });

  it('shows a refused rate once, beside the form', async () => {
    bridge.respond('cost', 'payRates', []);
    bridge.fail(
      'cost',
      'createPayRate',
      new Error('A rate for that nurse already starts on that date'),
    );
    renderWithApp(<PayRatesSection unitId="u-1" nurses={[]} />);
    fireEvent.change(await screen.findByTestId('pay-rate-hourly'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText(/Effective from/), { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rate' }));
    await screen.findAllByText('A rate for that nurse already starts on that date');
    expect(screen.getAllByText('A rate for that nurse already starts on that date')).toHaveLength(
      1,
    );
  });

  it('leaves the employee id off nurses whose names differ', async () => {
    bridge.respond('cost', 'payRates', [rate('r1', 'n1'), rate('r2', 'n2')]);
    renderWithApp(
      <PayRatesSection
        unitId="u-1"
        nurses={[
          { ...nurse('n1', 'Adams'), employeeId: 'E1' },
          { ...nurse('n2', 'Baker'), employeeId: 'E2' },
        ]}
      />,
    );
    expect(await screen.findByText('Adams, A')).toBeTruthy();
    expect(screen.getByText('Baker, A')).toBeTruthy();
    expect(screen.queryByText(/\(E\d+\)/)).toBeNull();
  });

  it('lists role defaults first, then nurses by name', async () => {
    bridge.respond('cost', 'payRates', [
      rate('r1', 'n2'),
      rate('r2', 'n1'),
      { id: 'r3', nurseId: null, role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2020-01-01') },
      {
        id: 'r4',
        nurseId: null,
        role: 'LPN',
        hourlyRate: 30,
        effectiveFrom: isoDate('2020-01-01'),
      },
    ]);
    renderWithApp(
      <PayRatesSection unitId="u-1" nurses={[nurse('n1', 'Adams'), nurse('n2', 'Baker')]} />,
    );
    await screen.findByText('Adams, A');
    const rows = within(screen.getByTestId('pay-rate-table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([
      'LPN default',
      'RN default',
      'Adams, A',
      'Baker, A',
    ]);
  });
});
