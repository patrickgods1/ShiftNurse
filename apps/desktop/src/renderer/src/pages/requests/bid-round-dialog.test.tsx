// @vitest-environment jsdom
/**
 * Editing a bidding round after nurses have bid: the dates and places they bid against cannot
 * move without a reason the audit log can quote.
 */

import type { LeaveBidRound } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaveBidRecord, LeaveBidRoundRecord } from '../../../../shared/api.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { BidRoundDialog } from './bid-round-dialog.js';

const date = (d: string) => d as LeaveBidRound['coversStart'];

const round: LeaveBidRoundRecord = {
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

const bid: LeaveBidRecord = {
  id: 'b-1',
  roundId: 'r-1',
  nurseId: 'n-ana',
  submittedAt: 1,
  enteredBy: 'manager',
  choices: [{ rank: 1, startDate: date('2027-07-05'), endDate: date('2027-07-09') }],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('leaveBidding', 'bids', [bid]);
  bridge.respond('leaveBidding', 'updateRound', round);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('editing a bidding round once bids are in', () => {
  it('asks for a reason when places change after bids are in', async () => {
    renderWithApp(<BidRoundDialog unitId="unit-1" round={round} onClose={() => {}} />);
    const dialog = within(await screen.findByRole('dialog'));
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    await waitFor(() => expect(bridge.callsTo('leaveBidding', 'bids')).not.toEqual([]));
    // Nothing judged has changed, so no reason is asked for.
    expect(dialog.queryByLabelText('Reason for the change')).toBeNull();

    fireEvent.change(dialog.getByLabelText('RN'), { target: { value: '2' } });
    const reason = await dialog.findByLabelText('Reason for the change');
    expect(save.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: 'More cover found' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(bridge.callsTo('leaveBidding', 'updateRound')).toEqual([
        [
          'r-1',
          {
            name: 'Summer 2027',
            coversStart: '2027-07-01',
            coversEnd: '2027-08-31',
            opensOn: '2027-03-01',
            closesOn: '2027-03-31',
            offPerDay: { RN: 2 },
            maxAwardsPerNurse: null,
          },
          'More cover found',
        ],
      ]),
    );
  });
});
