// @vitest-environment jsdom
/**
 * The nurse form's accessibility and soft checks: a label names its field and nothing else, an
 * error is the field's description, and warnings tell the manager what looks odd without
 * stopping Save.
 */

import { addDays, isoDate, type Nurse, today } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NurseFormDialog } from './nurse-form-dialog.js';

const created: Nurse = {
  id: 'n-new',
  unitId: 'unit-1',
  employeeId: 'E1',
  firstName: 'Ana',
  lastName: 'Cruz',
  role: 'RN',
  employmentType: 'full_time',
  fte: 0,
  contractedHoursPerPeriod: 0,
  seniorityDate: isoDate('2030-01-01'),
  isChargeEligible: false,
  isNovice: false,
  isFloatEligible: false,
  active: true,
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const openForm = () =>
  renderWithApp(
    <NurseFormDialog open onOpenChange={() => {}} unitId="unit-1" payPeriodDays={14} />,
  );

const hours = () => screen.getByLabelText(/Contracted hours/) as HTMLInputElement;
const fte = () => screen.getByLabelText('FTE') as HTMLInputElement;
const employment = () => screen.getByLabelText('Employment type') as HTMLSelectElement;
const describedText = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();

function fillRequired() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Employee ID' }), {
    target: { value: 'E1' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'First name' }), {
    target: { value: 'Ana' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Last name' }), {
    target: { value: 'Cruz' },
  });
  fireEvent.change(screen.getByLabelText('Seniority date'), { target: { value: '2020-01-06' } });
}

describe('the nurse form', () => {
  it('names Contracted hours by its label alone, and keeps the hint as its description', async () => {
    openForm();
    const box = await screen.findByRole('spinbutton', { name: 'Contracted hours / period' });
    expect(describedText(box)).toContain('Worked out from FTE');
  });

  it('ties each error to its box and puts the cursor in the first one', async () => {
    openForm();
    fireEvent.click(await screen.findByRole('button', { name: 'Add nurse' }));
    const id = screen.getByRole('textbox', { name: 'Employee ID' });
    expect(id.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(id)).toBe('Employee ID is required.');
    expect(document.activeElement).toBe(id);
    const seniority = screen.getByLabelText('Seniority date');
    expect(seniority.getAttribute('aria-invalid')).toBe('true');
    expect(describedText(seniority)).toBe('Seniority date is required.');
  });

  it('keeps a per-diem nurse at no contracted hours when the FTE changes', async () => {
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fireEvent.change(employment(), { target: { value: 'per_diem' } });
    expect(hours().value).toBe('0');
    fireEvent.change(fte(), { target: { value: '0.5' } });
    expect(hours().value).toBe('0');
  });

  it('works hours out again when a per-diem nurse is made full time', async () => {
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fireEvent.change(employment(), { target: { value: 'per_diem' } });
    fireEvent.change(fte(), { target: { value: '0.9' } });
    fireEvent.change(employment(), { target: { value: 'full_time' } });
    expect(hours().value).toBe('72');
  });

  it('warns about a full-time nurse at FTE 0 and a future seniority date, and still saves', async () => {
    bridge.respond('nurses', 'create', created);
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Employee ID' }), {
      target: { value: 'E1' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'First name' }), {
      target: { value: 'Ana' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Last name' }), {
      target: { value: 'Cruz' },
    });
    fireEvent.change(fte(), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Seniority date'), {
      target: { value: addDays(today(), 30) },
    });
    const list = screen.getByRole('list', { name: 'Check before saving' });
    expect(
      within(list).getByText('A full time nurse at FTE 0 has no contracted hours.'),
    ).toBeTruthy();
    expect(within(list).getByText('The seniority date is in the future.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add nurse' }));
    await waitFor(() => expect(bridge.callsTo('nurses', 'create')).toHaveLength(1));
  });

  it('refuses more contracted hours than a pay period holds', async () => {
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fillRequired();
    fireEvent.change(hours(), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add nurse' }));
    expect(
      screen.getByText(
        'Contracted hours must be 336 or fewer (24 hours a day for a 14-day pay period).',
      ),
    ).toBeTruthy();
    expect(bridge.callsTo('nurses', 'create')).toHaveLength(0);
  });

  it('warns about a hire date that has not come yet, without blocking', async () => {
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fireEvent.change(screen.getByLabelText('Hire date'), {
      target: { value: addDays(today(), 10) },
    });
    const list = screen.getByRole('list', { name: 'Check before saving' });
    expect(
      within(list).getByText(
        'The hire date is in the future; fine for a nurse who has not started yet.',
      ),
    ).toBeTruthy();
  });

  it('says per-diem and agency staff have no contracted minimum when hours are entered', async () => {
    openForm();
    await screen.findByRole('button', { name: 'Add nurse' });
    fireEvent.change(employment(), { target: { value: 'per_diem' } });
    expect(screen.queryByRole('list', { name: 'Check before saving' })).toBeNull();
    fireEvent.change(hours(), { target: { value: '40' } });
    expect(
      within(screen.getByRole('list', { name: 'Check before saving' })).getByText(
        'Per diem staff have no contracted minimum; the under-hours check skips them.',
      ),
    ).toBeTruthy();
    fireEvent.change(employment(), { target: { value: 'agency' } });
    expect(
      within(screen.getByRole('list', { name: 'Check before saving' })).getByText(
        'Agency staff have no contracted minimum; the under-hours check skips them.',
      ),
    ).toBeTruthy();
  });
});
