// @vitest-environment jsdom
/**
 * A nurse's leave on the roster: the balance payroll reports and the FMLA certifications. Each
 * button leads to exactly the payload that would cross IPC.
 */

import type { FmlaCertificationRecord, LeaveBalanceRecord } from '@shared/api.js';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { LeaveSection } from './nurse-leave.js';

const pto: LeaveBalanceRecord = {
  id: 'lb-1',
  nurseId: 'n-1',
  type: 'pto',
  balanceHours: 40,
  asOf: '2026-10-01' as LeaveBalanceRecord['asOf'],
};
const cert: FmlaCertificationRecord = {
  id: 'fc-1',
  nurseId: 'n-1',
  startDate: '2026-10-01' as FmlaCertificationRecord['startDate'],
  endDate: '2027-03-31' as FmlaCertificationRecord['endDate'],
  intermittent: true,
  note: 'Certified by Dr. Lee',
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('leaveBalances', 'forNurse', { balances: [pto], certifications: [cert] });
  bridge.respond('leaveBalances', 'setBalance', pto);
  bridge.respond('leaveBalances', 'addCertification', cert);
  bridge.respond('leaveBalances', 'updateCertification', cert);
  bridge.respond('leaveBalances', 'removeCertification', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a nurse’s leave on the roster', () => {
  it('shows the balance payroll gave and the certification on file', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    expect((await screen.findByLabelText('PTO balance (hours)')) as HTMLInputElement).toBeTruthy();
    expect((screen.getByLabelText('PTO balance (hours)') as HTMLInputElement).value).toBe('40');
    expect(screen.getByText('Certified by Dr. Lee')).toBeTruthy();
  });

  it('saves a new PTO balance with the date it was true on', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    fireEvent.change(await screen.findByLabelText('PTO balance (hours)'), {
      target: { value: '28' },
    });
    fireEvent.change(screen.getByLabelText('PTO balance as of'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save PTO balance' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'setBalance')).toEqual([
        ['n-1', 'pto', 28, '2026-10-15'],
      ]),
    );
  });

  it('enters a first sick balance', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    fireEvent.change(await screen.findByLabelText('Sick balance (hours)'), {
      target: { value: '24' },
    });
    fireEvent.change(screen.getByLabelText('Sick balance as of'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Sick balance' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'setBalance')).toEqual([
        ['n-1', 'sick', 24, '2026-10-01'],
      ]),
    );
  });

  it('adds a certification that allows intermittent leave', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add certification' }));
    fireEvent.change(screen.getByLabelText('Certified from'), { target: { value: '2027-04-01' } });
    fireEvent.change(screen.getByLabelText('Certified through'), {
      target: { value: '2027-09-30' },
    });
    fireEvent.click(screen.getByLabelText('Leave may be taken intermittently'));
    fireEvent.click(screen.getByRole('button', { name: 'Save certification' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'addCertification')).toEqual([
        [
          {
            nurseId: 'n-1',
            startDate: '2027-04-01',
            endDate: '2027-09-30',
            intermittent: true,
          },
        ],
      ]),
    );
  });

  it('clears a certification’s note with null when it is edited away', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit certification' }));
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save certification' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'updateCertification')).toEqual([
        [
          'fc-1',
          { startDate: '2026-10-01', endDate: '2027-03-31', intermittent: true, note: null },
        ],
      ]),
    );
  });

  it('removes a certification only after the manager confirms', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove certification' }));
    expect(bridge.callsTo('leaveBalances', 'removeCertification')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'removeCertification')).toEqual([['fc-1']]),
    );
  });
});
