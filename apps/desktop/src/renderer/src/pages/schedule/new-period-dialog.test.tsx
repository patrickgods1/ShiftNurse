// @vitest-environment jsdom
/**
 * The new-period form sends the dates the manager picked; the requests-close date follows the
 * start (four weeks earlier) until the manager sets it themselves.
 */

import { isoDate, type SchedulePeriod, type Unit } from '@shiftnurse/core';
import { testUnit } from '@shiftnurse/core/testing';
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

// Pay periods are 14 days counted from Sunday 2026-01-04.
const unit: Unit = {
  ...testUnit,
  id: 'unit-1',
  payPeriodAnchor: isoDate('2026-01-04'),
  payPeriodDays: 14,
};

function renderDialog(onCreated: (p: SchedulePeriod) => void = () => {}) {
  return renderWithApp(
    <NewPeriodDialog open onOpenChange={() => {}} unitId="unit-1" onCreated={onCreated} />,
    { unit },
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
    bridge.fail('periods', 'create', new Error('The period ends before it starts.'));
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The period ends before it starts.',
    );
  });

  // Anchor 2026-01-04 is day 4 of 2026; Dec 9 is day 343 (334 days to the end of November + 9),
  // so 339 days apart. 339 / 14 = 24 rem 3: pay period 24, starting 24 x 14 = 336 days after
  // Jan 4 = day 340 = Dec 6, ending Dec 19. Dec 6 + 28 days = Jan 3 2027, so Jan 16 2027 is the
  // last day of the pay period Jan 3 - Jan 16.
  it('says a period starting midway through a pay period is judged with the one before, and aligns it', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Start date'), '2026-12-09');
    set(field('End date'), '2027-01-16');
    const note = await screen.findByTestId('period-alignment');
    expect(note.textContent).toContain('starts partway');
    expect(note.textContent).not.toContain('ends partway');
    fireEvent.click(screen.getByText('Align to pay periods'));
    expect(field('Start date').value).toBe('2026-12-06');
    expect(field('End date').value).toBe('2027-01-16');
  });

  // Dec 9 - 28 days = Nov 11; aligning moves the start to Dec 6, and Dec 6 - 28 days = Nov 8.
  it('moves the untouched close date with the start when aligning to pay periods', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Start date'), '2026-12-09');
    set(field('End date'), '2027-01-16');
    expect(field(/Time-off requests close on/).value).toBe('2026-11-11');
    fireEvent.click(await screen.findByText('Align to pay periods'));
    expect(field(/Time-off requests close on/).value).toBe('2026-11-08');
  });

  it('lists the periods it overlaps, without refusing', async () => {
    const existing = (
      id: string,
      name: string,
      startDate: string,
      endDate: string,
      status: string,
    ) => ({ id, unitId: 'unit-1', name, startDate, endDate, status }) as unknown as SchedulePeriod;
    bridge.respond('periods', 'list', [
      existing('a', 'Autumn', '2026-10-25', '2026-12-05', 'published'),
      existing('w', 'Winter', '2026-12-06', '2027-01-16', 'draft'),
    ]);
    bridge.respond('periods', 'create', { id: 'p-new' } as SchedulePeriod);
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Bridge');
    set(field('Start date'), '2026-11-29');
    set(field('End date'), '2027-01-09');
    const lines = await screen.findAllByTestId('period-overlap');
    expect(lines.length).toBe(2);
    expect(lines[0]!.textContent).toContain('Autumn');
    expect(lines[1]!.textContent).toContain('Winter');
    submit();
    await waitFor(() => expect(bridge.callsTo('periods', 'create').length).toBe(1));
  });

  it('refuses requests that close after the period starts', async () => {
    renderDialog();
    await screen.findByTestId('new-period-form');
    set(field('Name'), 'Winter');
    set(field('Start date'), '2026-12-06');
    set(field('End date'), '2027-01-16');
    set(field(/Time-off requests close on/), '2026-12-10');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Requests must close on or before the day the period starts.',
    );
    expect(bridge.callsTo('periods', 'create')).toEqual([]);
  });
});
