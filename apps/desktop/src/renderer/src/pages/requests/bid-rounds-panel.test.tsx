// @vitest-environment jsdom
/**
 * Requests › Bid rounds: the manager sets up a round, enters a nurse's ranked choices and awards
 * it. Each button leads to exactly the payload that would cross IPC, and a denial's reason reaches
 * the screen word for word — it is what the manager reads to the nurse.
 */

import type { LeaveBidRound, Nurse } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LeaveBidAwardResult,
  LeaveBidRecord,
  LeaveBidRoundRecord,
} from '../../../../shared/api.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { BidRoundsPanel } from './bid-rounds-panel.js';

const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Martinez', active: true } as Nurse;
const ben = { id: 'n-ben', firstName: 'Ben', lastName: 'Okafor', active: true } as Nurse;

const date = (d: string) => d as LeaveBidRound['coversStart'];

const openRound: LeaveBidRoundRecord = {
  id: 'r-1',
  unitId: 'unit-1',
  name: 'Summer 2027',
  coversStart: date('2027-07-01'),
  coversEnd: date('2027-08-31'),
  opensOn: date('2027-03-01'),
  closesOn: date('2027-03-31'),
  offPerDay: { RN: 1 },
  status: 'open',
};

const anaBid: LeaveBidRecord = {
  id: 'b-ana',
  roundId: 'r-1',
  nurseId: 'n-ana',
  submittedAt: 1,
  enteredBy: 'manager',
  choices: [{ rank: 1, startDate: date('2027-07-05'), endDate: date('2027-07-09') }],
};

const DENIAL =
  'Choice 1 (Mon Jul 5 to Fri Jul 9): Mon Jul 5 to Fri Jul 9 already have the 1 RN off a day ' +
  'the round allows, taken by Ana Martinez, senior to Ben Okafor.';

const result: LeaveBidAwardResult = {
  round: { ...openRound, status: 'awarded', awardedAt: 5 },
  order: [
    { nurseId: 'n-ana', nurseName: 'Ana Martinez' },
    { nurseId: 'n-ben', nurseName: 'Ben Okafor' },
  ],
  awards: [
    {
      bidId: 'b-ana',
      nurseId: 'n-ana',
      nurseName: 'Ana Martinez',
      rank: 1,
      startDate: date('2027-07-05'),
      endDate: date('2027-07-09'),
      pass: 1,
      requestId: 'to-1',
      liftedShifts: 2,
      stillRostered: 0,
    },
  ],
  denials: [
    {
      bidId: 'b-ben',
      nurseId: 'n-ben',
      nurseName: 'Ben Okafor',
      rank: 1,
      startDate: date('2027-07-05'),
      endDate: date('2027-07-09'),
      pass: 1,
      fullDates: [],
      heldBy: ['n-ana'],
      reason: DENIAL,
    },
  ],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('leaveBidding', 'rounds', [openRound]);
  bridge.respond('leaveBidding', 'bids', [anaBid]);
  bridge.respond('leaveBidding', 'createRound', openRound);
  bridge.respond('leaveBidding', 'submitBid', anaBid);
  bridge.respond('leaveBidding', 'closeRound', { ...openRound, status: 'closed' });
  bridge.respond('leaveBidding', 'award', result);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const renderPanel = () => renderWithApp(<BidRoundsPanel unitId="unit-1" nurses={[ana, ben]} />);

describe('bidding for summer leave on the Requests page', () => {
  it('lists the round, its places and each nurse’s ranked choices, and says how seniority works', async () => {
    renderPanel();
    expect(await screen.findByText('Ana Martinez')).toBeTruthy();
    expect(screen.getByText(/Places off a day: 1 RN/)).toBeTruthy();
    expect(screen.getByText(/1\. Jul 5 – Jul 9, 2027/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About Bid rounds' })).toBeTruthy();
  });

  it('creates a round with its places and an optional limit', async () => {
    renderPanel();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('new-bid-round'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: ' Winter holidays ' } });
    fireEvent.change(dialog.getByLabelText('Season starts'), { target: { value: '2027-12-20' } });
    fireEvent.change(dialog.getByLabelText('Season ends'), { target: { value: '2028-01-02' } });
    fireEvent.change(dialog.getByLabelText('Bidding opens'), { target: { value: '2027-09-01' } });
    fireEvent.change(dialog.getByLabelText('Bidding closes'), { target: { value: '2027-09-30' } });
    fireEvent.change(dialog.getByLabelText('RN'), { target: { value: '2' } });
    fireEvent.change(dialog.getByRole('spinbutton', { name: /Most choices one nurse can win/ }), {
      target: { value: '1' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBidding', 'createRound')).toEqual([
        [
          {
            unitId: 'unit-1',
            name: 'Winter holidays',
            coversStart: '2027-12-20',
            coversEnd: '2028-01-02',
            opensOn: '2027-09-01',
            closesOn: '2027-09-30',
            offPerDay: { RN: 2 },
            maxAwardsPerNurse: 1,
          },
        ],
      ]),
    );
  });

  it('will not save a round whose season ends before it starts', async () => {
    renderPanel();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('new-bid-round'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: 'Backwards' } });
    fireEvent.change(dialog.getByLabelText('Season starts'), { target: { value: '2027-08-31' } });
    fireEvent.change(dialog.getByLabelText('Season ends'), { target: { value: '2027-07-01' } });
    expect(dialog.getByText('The season ends before it starts.')).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enters a nurse’s two choices in rank order', async () => {
    renderPanel();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('enter-bid'));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Nurse'), { target: { value: 'n-ben' } });
    fireEvent.change(dialog.getByLabelText('Choice 1 first day'), {
      target: { value: '2027-07-05' },
    });
    fireEvent.change(dialog.getByLabelText('Choice 1 last day'), {
      target: { value: '2027-07-09' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Add a choice' }));
    fireEvent.change(dialog.getByLabelText('Choice 2 first day'), {
      target: { value: '2027-07-19' },
    });
    fireEvent.change(dialog.getByLabelText('Choice 2 last day'), {
      target: { value: '2027-07-23' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Save bid' }));
    await waitFor(() =>
      expect(bridge.callsTo('leaveBidding', 'submitBid')).toEqual([
        [
          'r-1',
          'n-ben',
          [
            { rank: 1, startDate: '2027-07-05', endDate: '2027-07-09' },
            { rank: 2, startDate: '2027-07-19', endDate: '2027-07-23' },
          ],
        ],
      ]),
    );
  });

  it('awards only after the manager confirms, then shows each denial’s reason verbatim', async () => {
    renderPanel();
    await screen.findByText('Ana Martinez');
    fireEvent.click(screen.getByTestId('award-round'));
    expect(bridge.callsTo('leaveBidding', 'award')).toEqual([]);
    const confirmButtons = await screen.findAllByRole('button', {
      name: 'Award in seniority order',
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    await waitFor(() => expect(bridge.callsTo('leaveBidding', 'award')).toEqual([['r-1']]));

    const table = within(await screen.findByTestId('bid-result'));
    expect(table.getByText('Awarded: 1 won, 1 not awarded')).toBeTruthy();
    expect(table.getByText(/2 draft shifts taken off/)).toBeTruthy();
    expect(table.getByTestId('bid-denial').textContent).toBe(DENIAL);
  });
});
