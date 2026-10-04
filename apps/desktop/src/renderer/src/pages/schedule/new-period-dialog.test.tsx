// @vitest-environment jsdom
/**
 * The new-period form sends the dates the manager picked; the requests-close date follows the
 * start (four weeks earlier) until the manager sets it themselves.
 */

import { isoDate, type SchedulePeriod } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { NewPeriodDialog } from './new-period-dialog.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function renderDialog(onCreated: (p: SchedulePeriod) => void = () => {}) {
  return renderWithApp(
    <NewPeriodDialog open onOpenChange={() => {}} unitId="unit-1" onCreated={onCreated} />,
  );
}

const field = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const set = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const submit = () => fireEvent.click(screen.getByTestId('new-period-save'));

describe('creating a scheduling period', () => {
  it('sends the name and dates picked, with requests closing 28 days before the start', async () => {
    const created = { id: 'p-new' } as SchedulePeriod;
    bridge.respond('periods', 'create', created);
    const onCreated = vi.fn();
    renderDialog(onCreated);
    await screen.findByTestId('new-period-form');
    set(field('Name'), '  Winter  ');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    expect(field(/Time-off requests close on/).value).toBe('2026-11-08');
    submit();
    await waitFor(() =>
      expect(bridge.callsTo('periods', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            name: 'Winter',
            startDate: isoDate('2026-12-06'),
            endDate: isoDate('2027-01-16'),
            requestsCloseOn: isoDate('2026-11-08'),
          },
        ],
      ]),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it('keeps a requests-close date the manager chose when the start moves', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field(/Time-off requests close on/), '2026-11-20');
    set(field('Start date'), '2026-12-13');
    expect(field(/Time-off requests close on/).value).toBe('2026-11-20');
    set(field('End date'), '2027-01-23');
    submit();
    await waitFor(() =>
      expect(bridge.callsTo('periods', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            name: 'Winter',
            startDate: isoDate('2026-12-13'),
            endDate: isoDate('2027-01-23'),
            requestsCloseOn: isoDate('2026-11-20'),
          },
        ],
      ]),
    );
  });

  it('leaves out the close date when the manager clears it', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    set(field(/Time-off requests close on/), '');
    submit();
    await waitFor(() =>
      expect(bridge.callsTo('periods', 'create')).toEqual([
        [
          {
            unitId: 'unit-1',
            name: 'Winter',
            startDate: isoDate('2026-12-06'),
            endDate: isoDate('2027-01-16'),
          },
        ],
      ]),
    );
  });

  it('refuses an end date before the start without calling main', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2026-12-01');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('End date must be on or after the start date.');
    expect(bridge.callsTo('periods', 'create')).toEqual([]);
  });

  it('refuses a period with no name', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('Name is required.');
    expect(bridge.callsTo('periods', 'create')).toEqual([]);
  });

  it('shows the message when main refuses the period', async () => {
    bridge.fail('periods', 'create', new Error('That overlaps the October period.'));
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That overlaps the October period.',
    );
  });
});
