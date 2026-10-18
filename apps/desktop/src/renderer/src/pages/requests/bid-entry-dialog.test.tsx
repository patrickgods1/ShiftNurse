// @vitest-environment jsdom
/**
 * Changing a bid for a nurse who has since left: the dialog must still open on their name, not
 * on "Choose a nurse…", so the manager can see whose sheet they are editing.
 */

import type { Nurse } from '@shiftnurse/core';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaveBidRecord, LeaveBidRoundRecord } from '../../../../shared/api.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { BidEntryDialog } from './bid-entry-dialog.js';

const date = (d: string) => d as LeaveBidRoundRecord['coversStart'];

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

const oldBid: LeaveBidRecord = {
  id: 'b-old',
  roundId: 'r-1',
  nurseId: 'n-old',
  submittedAt: 1,
  enteredBy: 'manager',
  choices: [{ rank: 1, startDate: date('2027-07-05'), endDate: date('2027-07-09') }],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('changing the bid of a nurse who has left the unit', () => {
  it('keeps a bidder who has since left selected when the manager changes their bid', async () => {
    const lee = { id: 'n-old', firstName: 'Sam', lastName: 'Lee', active: false } as Nurse;
    const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Martinez', active: true } as Nurse;
    renderWithApp(
      <BidEntryDialog
        round={round}
        nurses={[ana, lee]}
        bids={[oldBid]}
        nurseId="n-old"
        onClose={() => {}}
      />,
    );
    const select = (await screen.findByLabelText('Nurse')) as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe('Lee, Sam (no longer active)');
    expect(screen.queryByText('Choose a nurse.')).toBeNull();
  });
});
