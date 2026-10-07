// @vitest-environment jsdom
/**
 * Settings › Pay › Overtime: the two bases a holdover and a long unbroken stretch are priced by.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../../test/fake-bridge.js';
import { renderWithApp } from '../../../test/render.js';
import { OvertimeSection } from './overtime.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('cost', 'overtimeRules', []);
  bridge.respond('cost', 'createOvertimeRule', {} as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('overtime bases in Settings › Pay', () => {
  it('offers overtime past the end of the scheduled tour and for consecutive hours', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = (await screen.findByLabelText('Basis')) as HTMLSelectElement;
    const options = Array.from(basis.options).map((o) => [o.value, o.text]);
    expect(options).toContainEqual(['beyond_scheduled_tour', 'Past the end of the scheduled tour']);
    expect(options).toContainEqual(['consecutive', 'Consecutive hours worked']);
  });

  it('explains the threshold for each, and saves a consecutive-hours rule', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = await screen.findByLabelText('Basis');
    fireEvent.change(basis, { target: { value: 'beyond_scheduled_tour' } });
    expect(screen.getByText('Grace before a holdover becomes overtime; 0 for none.')).toBeTruthy();
    fireEvent.change(basis, { target: { value: 'consecutive' } });
    expect(screen.getByText(/38 U\.S\.C\. §7453\(e\): 8/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Threshold (hours)'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createOvertimeRule')).toEqual([
        [{ unitId: 'u-1', basis: 'consecutive', thresholdHours: 8, multiplier: 1.5, active: true }],
      ]),
    );
  });

  it('offers the extra-day basis and explains its threshold', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = (await screen.findByLabelText('Basis')) as HTMLSelectElement;
    expect(Array.from(basis.options).map((o) => [o.value, o.text])).toContainEqual([
      'beyond_scheduled_days',
      'Workday beyond the scheduled days per week',
    ]);
    fireEvent.change(basis, { target: { value: 'beyond_scheduled_days' } });
    expect(screen.getByText(/Wage Order 5 § 3\(B\)\(8\): 8/)).toBeTruthy();
    expect(screen.queryByLabelText(/Don't count daily overtime/)).toBeNull();
  });

  it('sends pyramiding none for a weekly rule when the box is ticked, and omits it otherwise', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    await screen.findByLabelText('Basis');
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(bridge.callsTo('cost', 'createOvertimeRule')).toHaveLength(1));
    fireEvent.click(screen.getByLabelText("Don't count daily overtime toward this threshold"));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(bridge.callsTo('cost', 'createOvertimeRule')).toHaveLength(2));
    const [plain, ticked] = bridge.callsTo('cost', 'createOvertimeRule').map((c) => c[0]);
    expect('pyramiding' in plain!).toBe(false);
    expect(ticked).toMatchObject({ basis: 'weekly', pyramiding: 'none' });
  });

  it('sends the minimum minutes only when one is entered', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Minimum minutes'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'createOvertimeRule')).toEqual([
        [
          {
            unitId: 'u-1',
            basis: 'weekly',
            thresholdHours: 40,
            multiplier: 1.5,
            active: true,
            minimumMinutes: 15,
          },
        ],
      ]),
    );
  });

  it('scopes a daily rule to Baylor nurses on tour days, and sends nothing for an unscoped one', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    fireEvent.change(await screen.findByLabelText('Basis'), { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('Tour days'), { target: { value: 'only' } });
    fireEvent.click(screen.getByLabelText(/VA Baylor weekend plan/));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(bridge.callsTo('cost', 'createOvertimeRule')).toHaveLength(1));
    expect(bridge.callsTo('cost', 'createOvertimeRule')[0]![0]).toMatchObject({
      basis: 'daily',
      tourDays: 'only',
      scheduleKinds: ['va_baylor'],
    });
  });

  it('drops the tour-days choice when the basis moves away from daily', async () => {
    renderWithApp(<OvertimeSection unitId="u-1" />);
    const basis = await screen.findByLabelText('Basis');
    fireEvent.change(basis, { target: { value: 'daily' } });
    fireEvent.change(screen.getByLabelText('Tour days'), { target: { value: 'except' } });
    fireEvent.change(basis, { target: { value: 'weekly' } });
    expect(screen.queryByLabelText('Tour days')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(bridge.callsTo('cost', 'createOvertimeRule')).toHaveLength(1));
    const sent = bridge.callsTo('cost', 'createOvertimeRule')[0]![0];
    expect('tourDays' in sent).toBe(false);
    expect('scheduleKinds' in sent).toBe(false);
  });

  it('shows the scope on the rule in the list', async () => {
    bridge.respond('cost', 'overtimeRules', [
      {
        id: 'o1',
        unitId: 'u-1',
        basis: 'daily',
        thresholdHours: 12,
        multiplier: 1.5,
        active: true,
        scheduleKinds: ['va_72_80'],
        tourDays: 'only',
      },
    ]);
    renderWithApp(<OvertimeSection unitId="u-1" />);
    expect(await screen.findByText(/72\/80 nurses, tour days/)).toBeTruthy();
  });
});
