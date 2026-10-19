// @vitest-environment jsdom
/**
 * The dashboard's cost card: the schedule's own cost, and beside it the period's day-of pay, which
 * is listed line by line and never folded into the schedule's total.
 */

import type { PeriodCostReport } from '@shared/api.js';
import type { Nurse, SchedulePeriod } from '@shiftnurse/core';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CostPanel } from './cost-panel.js';

const period = {
  id: 'p-1',
  name: 'Fall',
  startDate: '2026-10-04',
  endDate: '2026-11-14',
} as SchedulePeriod;
const ana = { id: 'n-ana', firstName: 'Ana', lastName: 'Cruz' } as Nurse;

function report(dayOf: PeriodCostReport['dayOf']): PeriodCostReport {
  return {
    period,
    cost: {
      assignments: [{}],
      totals: { total: 50000, hours: 900, base: 40000, differentials: 8000, overtimePremium: 2000 },
      overtime: {
        ranked: [],
        totalHours: 0,
        totalPremium: 0,
        topThreeShare: 0,
        gini: 0,
        nursesWithOvertime: 0,
      },
      unpricedAssignments: 0,
      unpricedNurseIds: [],
    } as unknown as PeriodCostReport['cost'],
    budget: undefined,
    variance: undefined,
    dayOf,
    pricedUnder: undefined,
  };
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('day-of pay on the cost card', () => {
  it('lists each line and its total beside a schedule total it does not change', async () => {
    bridge.respond(
      'cost',
      'report',
      report({
        lines: [
          {
            nurseId: 'n-ana',
            date: '2026-10-06' as never,
            kind: 'missed_meal',
            hours: 1,
            rate: 50,
            amount: 50,
            note: 'Missed meal break on Tue Oct 6',
          },
          {
            nurseId: 'n-ana',
            date: '2026-10-07' as never,
            kind: 'reporting_pay',
            hours: 4,
            rate: 50,
            amount: 200,
            note: 'Sent home on Wed Oct 7 after 0h of a 12h shift',
          },
        ],
        total: 250,
        unpriced: 0,
      }),
    );
    renderWithApp(<CostPanel period={period} nurses={[ana]} />);
    expect((await screen.findByTestId('day-of-pay-total')).textContent).toBe('$250.00');
    expect(screen.getByTestId('cost-total').textContent).toBe('$50,000');
    expect(screen.getByText('Missed meal break on Tue Oct 6')).toBeTruthy();
    expect(screen.getAllByText('Cruz, Ana')).toHaveLength(2);
    expect(screen.queryByTestId('day-of-pay-unpriced')).toBeNull();
  });

  it('says how many events could not be priced, rather than showing them as free', async () => {
    bridge.respond('cost', 'report', report({ lines: [], total: 0, unpriced: 2 }));
    renderWithApp(<CostPanel period={period} nurses={[ana]} />);
    expect((await screen.findByTestId('day-of-pay-unpriced')).textContent).toContain(
      '2 events could not be priced',
    );
    expect(screen.getByText('Nothing recorded for this period.')).toBeTruthy();
  });
});

describe('the budget on the cost card', () => {
  const withBudget = (): PeriodCostReport => ({
    ...report({ lines: [], total: 0, unpriced: 0 }),
    budget: { targetDollars: 50000 } as PeriodCostReport['budget'],
  });

  it('removes the budget when the manager clears the field and saves', async () => {
    bridge.respond('cost', 'report', withBudget());
    renderWithApp(<CostPanel period={period} nurses={[ana]} />);
    fireEvent.click(await screen.findByTestId('edit-budget'));
    fireEvent.change(screen.getByLabelText('Budget in dollars'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(bridge.callsTo('cost', 'clearBudget')).toEqual([['p-1']]));
    expect(bridge.callsTo('cost', 'setBudget')).toEqual([]);
  });

  it('refuses a negative budget and says why', async () => {
    bridge.respond('cost', 'report', withBudget());
    renderWithApp(<CostPanel period={period} nurses={[ana]} />);
    fireEvent.click(await screen.findByTestId('edit-budget'));
    fireEvent.change(screen.getByLabelText('Budget in dollars'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Must be at least 0. Leave it blank to remove the budget.',
    );
    expect(bridge.callsTo('cost', 'setBudget')).toEqual([]);
    expect(bridge.callsTo('cost', 'clearBudget')).toEqual([]);
  });

  it('shows names, not ids, while the roster is still loading', async () => {
    const base = report({ lines: [], total: 0, unpriced: 0 });
    bridge.respond('cost', 'report', {
      ...base,
      cost: {
        ...base.cost,
        overtime: {
          ...base.cost.overtime,
          ranked: [{ nurseId: 'n-ana', hours: 8, premium: 200, share: 1 }],
        },
      },
    } as PeriodCostReport);
    renderWithApp(<CostPanel period={period} nurses={undefined} />);
    expect(await screen.findByLabelText('Loading name')).toBeTruthy();
    expect(document.body.textContent).not.toContain('n-ana');
  });
});
