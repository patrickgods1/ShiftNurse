// @vitest-environment jsdom

import type { PeriodCostReport } from '@shared/api.js';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { costPill } from './cost-summary.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respondDefault([]);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const TAKEN_AT = Date.UTC(2026, 8, 14, 15, 0);

function report(pricedUnder: PeriodCostReport['pricedUnder']): PeriodCostReport {
  return {
    cost: {
      totals: { total: 431911, hours: 5000 },
      overtime: { totalHours: 0, totalPremium: 0, nursesWithOvertime: 0 },
      unpricedAssignments: 0,
    },
    variance: undefined,
    pricedUnder,
  } as unknown as PeriodCostReport;
}

function renderDetail(
  pricedUnder: PeriodCostReport['pricedUnder'],
  status: 'draft' | 'published' | 'archived' = 'published',
) {
  const pill = costPill({
    report: report(pricedUnder),
    previewLabel: undefined,
    period: { id: 'p1', name: 'October 2026', status },
  });
  return renderWithApp(<div>{pill?.detail}</div>);
}

describe('the cost detail of a published schedule', () => {
  it('says which pay settings priced a published schedule', async () => {
    renderDetail({ takenAt: TAKEN_AT, reason: 'Retroactive raise' });
    const line = (await screen.findByTestId('cost-priced-under')).textContent ?? '';
    expect(line).toContain('Priced with the pay settings of');
    // 15:00 UTC on 14 Sep is 11:00 in New York (EDT, UTC-4), where the suite is pinned to run.
    expect(line).toContain('Sep 14, 2026');
    expect(line).toContain('11:00');
    expect(line).toContain('(repriced: Retroactive raise)');
  });

  it('reprices with the reason typed', async () => {
    renderDetail({ takenAt: TAKEN_AT });
    expect((await screen.findByTestId('cost-priced-under')).textContent).not.toContain('repriced');
    fireEvent.click(screen.getByRole('button', { name: /Reprice with today’s settings/ }));
    expect(screen.getByText('Reprice October 2026?')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Reprice' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Retroactive raise' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(bridge.callsTo('cost', 'reprice')).toEqual([['p1', 'Retroactive raise']]),
    );
  });

  it('shows why the reprice was refused, in the dialog', async () => {
    bridge.fail('cost', 'reprice', new Error('Archived periods cannot be repriced.'));
    renderDetail({ takenAt: TAKEN_AT });
    fireEvent.click(await screen.findByRole('button', { name: /Reprice with today’s settings/ }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Retroactive raise' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reprice' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Archived periods cannot be repriced.');
    expect(screen.getByText('Reprice October 2026?')).toBeTruthy();
  });

  it('offers no repricing on a draft', async () => {
    renderDetail(undefined, 'draft');
    await screen.findByText(/premium/);
    expect(screen.queryByTestId('cost-priced-under')).toBeNull();
    expect(screen.queryByRole('button', { name: /Reprice/ })).toBeNull();
  });

  it('offers no repricing on an archived period', async () => {
    renderDetail({ takenAt: TAKEN_AT }, 'archived');
    await screen.findByText(/premium/);
    expect(screen.queryByRole('button', { name: /Reprice/ })).toBeNull();
  });
});
