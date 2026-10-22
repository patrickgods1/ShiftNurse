// @vitest-environment jsdom
/**
 * A nurse's leave on the roster: the balance payroll reports and the FMLA certifications. Each
 * button leads to exactly the payload that would cross IPC.
 */

import type {
  CompTimeElectionRecord,
  FmlaCertificationRecord,
  LeaveBalanceRecord,
  PaySettings,
} from '@shared/api.js';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConfirmDiscard } from '../../components/unsaved-changes.js';
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

const election: CompTimeElectionRecord = {
  id: 'ce-1',
  unitId: 'u-1',
  nurseId: 'n-1',
  startsOn: '2026-10-01' as CompTimeElectionRecord['startsOn'],
  note: 'Signed 12 Dec',
};
const settingsWith = (compTime: PaySettings['compTime']) => ({ compTime }) as PaySettings;

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('leaveBalances', 'forNurse', { balances: [pto], certifications: [cert] });
  bridge.respond('leaveBalances', 'setBalance', pto);
  bridge.respond('leaveBalances', 'addCertification', cert);
  bridge.respond('leaveBalances', 'updateCertification', cert);
  bridge.respond('leaveBalances', 'removeCertification', undefined);
  bridge.respond('cost', 'paySettings', settingsWith(null));
  bridge.respond('leaveBalances', 'compElections', [election]);
  bridge.respond('leaveBalances', 'addCompElection', election);
  bridge.respond('leaveBalances', 'removeCompElection', undefined);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a nurse’s leave on the roster', () => {
  it('enters an annual leave balance, a type only some employers use', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Annual leave balance' }));
    fireEvent.change(await screen.findByLabelText('Annual leave balance (hours)'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('Annual leave balance as of'), {
      target: { value: '2026-10-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Annual leave balance' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'setBalance')).toEqual([
        ['n-1', 'annual', 100, '2026-10-01'],
      ]),
    );
  });

  it('shows the balance payroll gave and the certification on file', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    expect((await screen.findByLabelText('PTO balance (hours)')) as HTMLInputElement).toBeTruthy();
    expect((screen.getByLabelText('PTO balance (hours)') as HTMLInputElement).value).toBe('40');
    expect(screen.getByText('Certified by Dr. Lee')).toBeTruthy();
  });

  it('saves a new PTO balance with the date it was true on', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
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
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    expect(screen.queryByLabelText('Sick balance (hours)')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Sick balance' }));
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

  it('names each certification’s buttons by its dates', async () => {
    const second = {
      ...cert,
      id: 'fc-2',
      startDate: '2027-04-01' as FmlaCertificationRecord['startDate'],
      endDate: '2027-06-30' as FmlaCertificationRecord['endDate'],
    };
    bridge.respond('leaveBalances', 'forNurse', {
      balances: [pto],
      certifications: [cert, second],
    });
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    expect(
      await screen.findByRole('button', { name: 'Edit certification Oct 1, 2026 to Mar 31, 2027' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Edit certification Apr 1, 2027 to Jun 30, 2027' }),
    ).toBeTruthy();
  });

  it('adds a certification that allows intermittent leave', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
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
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit certification Oct 1, 2026 to Mar 31, 2027' }),
    );
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
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove certification Oct 1, 2026 to Mar 31, 2027',
      }),
    );
    expect(bridge.callsTo('leaveBalances', 'removeCertification')).toEqual([]);
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBalances', 'removeCertification')).toEqual([['fc-1']]),
    );
  });

  it('counts a typed balance and an edited certification as unsaved changes', async () => {
    let ask: ReturnType<typeof useConfirmDiscard> | undefined;
    function Probe() {
      ask = useConfirmDiscard();
      return null;
    }
    renderWithApp(
      <>
        <Probe />
        <LeaveSection nurseId="n-1" unitId="u-1" />
      </>,
    );
    // Nothing typed yet: leaving asks nothing.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit certification Oct 1, 2026 to Mar 31, 2027' }),
    );
    expect(await ask?.()).toBe(true);

    fireEvent.change(screen.getByLabelText('Certified through'), {
      target: { value: '2027-04-30' },
    });
    const pending = ask?.();
    await screen.findByText('Discard unsaved changes to FMLA certification?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await pending).toBe(false);

    fireEvent.change(screen.getByLabelText('PTO balance (hours)'), { target: { value: '41' } });
    const both = ask?.();
    await screen.findByText('Discard unsaved changes to FMLA certification and PTO balance?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await both).toBe(false);
  });
});

describe('a nurse’s comp-time elections on the roster', () => {
  it('shows nothing about comp time on a unit that does not give it', async () => {
    renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
    await screen.findByLabelText('PTO balance (hours)');
    await waitFor(() => expect(bridge.callsTo('cost', 'paySettings')).toHaveLength(1));
    expect(screen.queryByText('Comp time instead of overtime')).toBeNull();
    expect(bridge.callsTo('leaveBalances', 'compElections')).toEqual([]);
  });

  describe('on a unit that gives comp time', () => {
    beforeEach(() => {
      bridge.respond(
        'cost',
        'paySettings',
        settingsWith({ hoursPerOvertimeHour: 1.5, capHours: 240 }),
      );
    });

    it('lists an open-ended election with its note and the hint', async () => {
      renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
      expect(await screen.findByText('Comp time instead of overtime')).toBeTruthy();
      expect(await screen.findByText('from Oct 1, 2026, open-ended')).toBeTruthy();
      expect(screen.getByText('Signed 12 Dec')).toBeTruthy();
      expect(
        screen.getByText(/29 U\.S\.C\. § 207\(o\) needs the agreement before the work/),
      ).toBeTruthy();
    });

    it('adds an election for the unit being shown', async () => {
      renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Add election' }));
      fireEvent.change(screen.getByLabelText('Agreed from'), { target: { value: '2026-11-01' } });
      fireEvent.change(screen.getByLabelText('Agreed through (blank: open-ended)'), {
        target: { value: '2027-01-31' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save election' }));
      await waitFor(() =>
        expect(bridge.callsTo('leaveBalances', 'addCompElection')).toEqual([
          [{ unitId: 'u-1', nurseId: 'n-1', startsOn: '2026-11-01', endsOn: '2027-01-31' }],
        ]),
      );
    });

    it('reopens the end when the through date is cleared on edit', async () => {
      bridge.respond('leaveBalances', 'compElections', [
        { ...election, endsOn: '2026-12-31' as never },
      ]);
      bridge.respond('leaveBalances', 'updateCompElection', election);
      renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
      fireEvent.click(
        await screen.findByRole('button', { name: 'Edit election Oct 1, 2026 to Dec 31, 2026' }),
      );
      fireEvent.change(screen.getByLabelText('Agreed through (blank: open-ended)'), {
        target: { value: '' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save election' }));
      await waitFor(() =>
        expect(bridge.callsTo('leaveBalances', 'updateCompElection')).toEqual([
          ['ce-1', { startsOn: '2026-10-01', endsOn: null, note: 'Signed 12 Dec' }],
        ]),
      );
    });

    it('removes an election only after the manager confirms', async () => {
      renderWithApp(<LeaveSection nurseId="n-1" unitId="u-1" />);
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Remove election from Oct 1, 2026, open-ended',
        }),
      );
      expect(bridge.callsTo('leaveBalances', 'removeCompElection')).toEqual([]);
      fireEvent.click(await screen.findByTestId('confirm-accept'));
      await waitFor(() =>
        expect(bridge.callsTo('leaveBalances', 'removeCompElection')).toEqual([['ce-1']]),
      );
    });
  });
});
