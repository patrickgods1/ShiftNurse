// @vitest-environment jsdom
/**
 * Settings › Coverage floors. Each weekday cell is a minimum / target pair that saves when focus
 * leaves the pair and only if the numbers changed: the manager tabs across a week without
 * writing anything, and a save coming back never takes the digit she is typing.
 */

import type { CoverageRequirement, ShiftType } from '@shiftnurse/core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConfirmDiscard } from '../../components/unsaved-changes.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import CoverageFloors from './coverage-floors.js';

const dayShift: ShiftType = {
  id: 'st-d',
  unitId: 'u-1',
  name: 'Day',
  abbreviation: 'D',
  startTime: '07:00',
  durationHours: 12,
  isNight: false,
  isOnCall: false,
  color: '#ffffff',
  sortOrder: 1,
  active: true,
  withinShiftTypeId: null,
};

const req = (weekday: number, minCount: number, targetCount: number): CoverageRequirement => ({
  id: `c-${weekday}`,
  unitId: 'u-1',
  shiftTypeId: 'st-d',
  weekday: weekday as CoverageRequirement['weekday'],
  date: null,
  role: 'RN',
  minCount,
  targetCount,
});

const monday: CoverageRequirement = {
  id: 'c1',
  unitId: 'u-1',
  shiftTypeId: 'st-d',
  weekday: 1,
  date: null,
  role: 'RN',
  minCount: 3,
  targetCount: 6,
};

let setRequirements: (next: CoverageRequirement[]) => void = () => undefined;

function Harness({ initial = [monday] }: { initial?: CoverageRequirement[] }) {
  const [requirements, set] = useState<CoverageRequirement[]>(initial);
  setRequirements = set;
  const confirmDiscard = useConfirmDiscard();
  return (
    <>
      <CoverageFloors unitId="u-1" shiftTypes={[dayShift]} requirements={requirements} />
      {/* Stands in for a Settings tab switch, which asks the unsaved-changes registry. */}
      <button type="button" onClick={() => void confirmDiscard()}>
        Leave settings
      </button>
    </>
  );
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('coverage', 'upsert', (input) => ({ ...input, id: input.id ?? 'new' }) as never);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const input = (kind: 'min' | 'target', weekday: number) =>
  document.getElementById(`${kind}-st-d-RN-${weekday}`) as HTMLInputElement;

describe('Settings › Coverage floors', () => {
  it('tabs through the week without writing anything', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    const order = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [input('min', d), input('target', d)]);
    for (const el of order) act(() => el.focus());
    act(() => order[order.length - 1]!.blur());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
  });

  it('keeps what the manager is typing when the save returns', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    act(() => input('min', 1).focus());
    fireEvent.change(input('min', 1), { target: { value: '4' } });
    act(() => input('target', 1).focus());
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
    const target = input('target', 1);
    fireEvent.change(target, { target: { value: '7' } });

    act(() => setRequirements([{ ...monday }]));
    expect(input('target', 1)).toBe(target);
    expect(target.value).toBe('7');
    expect(document.activeElement).toBe(target);

    act(() => input('min', 2).focus());
    await waitFor(() =>
      expect(bridge.callsTo('coverage', 'upsert')).toEqual([
        [
          {
            id: 'c1',
            unitId: 'u-1',
            shiftTypeId: 'st-d',
            weekday: 1,
            date: null,
            role: 'RN',
            minCount: 4,
            targetCount: 7,
          },
        ],
      ]),
    );
  });

  it('a value saved elsewhere shows up while the cell is idle', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    expect(input('min', 1).value).toBe('3');
    act(() => setRequirements([{ ...monday, minCount: 5, targetCount: 8 }]));
    await waitFor(() => expect(input('min', 1).value).toBe('5'));
    expect(input('target', 1).value).toBe('8');
  });

  it('says the target cannot be below the minimum and saves nothing', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    act(() => input('min', 1).focus());
    fireEvent.change(input('min', 1), { target: { value: '5' } });
    act(() => input('target', 1).focus());
    fireEvent.change(input('target', 1), { target: { value: '4' } });
    act(() => input('target', 1).blur());
    expect(await screen.findByText('The target cannot be below the minimum.')).toBeTruthy();
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
    expect(input('min', 1).getAttribute('aria-invalid')).toBe('true');
    expect(input('target', 1).getAttribute('aria-invalid')).toBe('true');
  });

  it('a cleared override is not saved as zero', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-12-24' } });
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add override' }));
    expect(await screen.findByText('Enter both numbers as whole numbers.')).toBeTruthy();
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
  });

  it('keeps the date when an override is refused', async () => {
    bridge.fail('coverage', 'upsert', new Error('Refused.'));
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    const date = screen.getByLabelText('Date') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-12-24' } });
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add override' }));
    await waitFor(() => expect(bridge.callsTo('coverage', 'upsert')).toHaveLength(1));
    expect(bridge.callsTo('coverage', 'upsert')[0]).toEqual([
      {
        unitId: 'u-1',
        shiftTypeId: 'st-d',
        weekday: null,
        date: '2026-12-24',
        role: 'RN',
        minCount: 5,
        targetCount: 6,
      },
    ]);
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-12-24');
  });

  it('asks before Same all week overwrites weekdays that differ', async () => {
    bridge.respond('coverage', 'fillWeek', () => [] as never);
    const week = [req(0, 4, 4), req(6, 4, 4), ...[1, 2, 3, 4, 5].map((d) => req(d, 3, 3))];
    renderWithApp(<Harness initial={week} />);
    await screen.findByText('Coverage floors');
    fireEvent.click(screen.getByRole('button', { name: 'Same all week' }));
    expect(await screen.findByText("Copy Sunday's 4 / 4 to every day?")).toBeTruthy();
    expect(
      screen.getByText(
        'Monday, Tuesday, Wednesday, Thursday and Friday are different now and will be changed.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(bridge.callsTo('coverage', 'fillWeek')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Same all week' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to every day' }));
    await waitFor(() =>
      expect(bridge.callsTo('coverage', 'fillWeek')).toEqual([
        [{ unitId: 'u-1', shiftTypeId: 'st-d', role: 'RN', minCount: 4, targetCount: 4 }],
      ]),
    );
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
  });

  it('fills empty days without asking', async () => {
    bridge.respond('coverage', 'fillWeek', () => [] as never);
    renderWithApp(<Harness initial={[req(1, 3, 6)]} />);
    await screen.findByText('Coverage floors');
    fireEvent.click(screen.getByRole('button', { name: 'Same all week' }));
    await waitFor(() =>
      expect(bridge.callsTo('coverage', 'fillWeek')).toEqual([
        [{ unitId: 'u-1', shiftTypeId: 'st-d', role: 'RN', minCount: 3, targetCount: 6 }],
      ]),
    );
    expect(screen.queryByText(/to every day\?/)).toBeNull();
  });

  it('keeps a refused cell edit on screen and holds it as unsaved', async () => {
    bridge.fail('coverage', 'upsert', new Error('The unit is locked.'));
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    act(() => input('min', 1).focus());
    fireEvent.change(input('min', 1), { target: { value: '4' } });
    act(() => input('min', 2).focus());
    // The app's toast says it too, so the cell's own message is one of two.
    expect((await screen.findAllByText(/The unit is locked\./)).length).toBeGreaterThan(0);
    expect(input('min', 1).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
    expect(await screen.findByText('Discard unsaved changes to Coverage floors?')).toBeTruthy();
  });

  it('follows the saved numbers again after its own save, and after a later outside change', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    act(() => input('min', 1).focus());
    fireEvent.change(input('min', 1), { target: { value: '4' } });
    act(() => input('min', 2).focus());
    await waitFor(() => expect(bridge.callsTo('coverage', 'upsert')).toHaveLength(1));
    act(() => setRequirements([{ ...monday, minCount: 4, targetCount: 6 }]));
    await waitFor(() => expect(input('min', 1).value).toBe('4'));
    expect(input('target', 1).value).toBe('6');
    act(() => setRequirements([{ ...monday, minCount: 9, targetCount: 9 }]));
    await waitFor(() => expect(input('min', 1).value).toBe('9'));
    expect(input('target', 1).value).toBe('9');
  });

  it('does not nag about an empty Target while the manager is still tabbing through a new cell', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    act(() => input('min', 2).focus());
    fireEvent.change(input('min', 2), { target: { value: '2' } });
    act(() => input('target', 2).focus());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText('Enter both numbers as whole numbers.')).toBeNull();
    expect(bridge.callsTo('coverage', 'upsert')).toEqual([]);
  });

  it('points the inputs at the error and gives them one name each', async () => {
    renderWithApp(<Harness />);
    await screen.findByText('Coverage floors');
    expect(input('min', 1).hasAttribute('aria-label')).toBe(false);
    expect(input('target', 1).hasAttribute('aria-label')).toBe(false);
    act(() => input('min', 1).focus());
    fireEvent.change(input('min', 1), { target: { value: '8' } });
    act(() => input('min', 2).focus());
    const message = await screen.findByText('The target cannot be below the minimum.');
    expect(message.id).toBe('st-d-RN-1-error');
    expect(input('min', 1).getAttribute('aria-describedby')).toBe(message.id);
    expect(input('target', 1).getAttribute('aria-describedby')).toBe(message.id);
  });

  it('shows a refused Same all week beside the button, once', async () => {
    bridge.fail('coverage', 'fillWeek', new Error('The unit is locked.'));
    renderWithApp(<Harness initial={[req(1, 3, 6)]} />);
    await screen.findByText('Coverage floors');
    fireEvent.click(screen.getByRole('button', { name: 'Same all week' }));
    expect(await screen.findAllByText('The unit is locked.')).toHaveLength(1);
  });

  it('says Copying while the week is being filled', async () => {
    bridge.respond('coverage', 'fillWeek', () => new Promise(() => undefined) as never);
    renderWithApp(<Harness initial={[req(1, 3, 6)]} />);
    await screen.findByText('Coverage floors');
    fireEvent.click(screen.getByRole('button', { name: 'Same all week' }));
    expect(await screen.findByRole('button', { name: 'Copying…' })).toBeTruthy();
  });

  it('holds a new row as unsaved until one of its cells is saved', async () => {
    renderWithApp(<Harness initial={[]} />);
    await screen.findByText('Coverage floors');
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
    expect(await screen.findByText('Discard unsaved changes to Coverage rows?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/Discard unsaved/)).toBeNull());

    act(() => setRequirements([req(1, 3, 6)]));
    fireEvent.click(screen.getByRole('button', { name: 'Leave settings' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(/Discard unsaved/)).toBeNull();
  });
});
