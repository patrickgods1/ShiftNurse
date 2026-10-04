// @vitest-environment jsdom
/**
 * Undo for grid edits, driven the way a manager meets it: make an edit, press Undo on the toast
 * (or Ctrl-Z), and check exactly what crossed IPC. Server-side a move and a swap re-create their
 * shifts, so the interesting cases are the ones where the inverse must use the *new* ids.
 */

import { type Assignment, isoDate, type SchedulePeriod } from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
} from '@shiftnurse/core/testing';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorMessage } from '../../components/ui.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { useGridEdits } from './use-grid-edits.js';

const ana = makeNurse({ id: 'n-ana', firstName: 'Ana', lastName: 'Ruiz' });
const ben = makeNurse({ id: 'n-ben', firstName: 'Ben', lastName: 'Okafor' });
const shiftTypes = [DAY_12, NIGHT_12];

const basePeriod: SchedulePeriod = {
  id: 'period-1',
  unitId: 'unit-1',
  name: 'Oct',
  startDate: isoDate('2026-10-05'),
  endDate: isoDate('2026-10-18'),
  status: 'draft',
  ruleSetId: 'rs-1',
  ruleSetVersion: 1,
};

let anaMonday: Assignment;
let benMonday: Assignment;
let bridge: FakeBridge;

beforeEach(() => {
  resetFixtureCounters();
  bridge = installFakeBridge();
  anaMonday = assign(ana.id, DAY_12, '2026-10-05', { id: 'a-ana' });
  benMonday = assign(ben.id, NIGHT_12, '2026-10-05', { id: 'a-ben' });
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function Host({ published = false, held }: { published?: boolean; held: Assignment[] }) {
  const [dialog, setDialog] = useState(false);
  const edits = useGridEdits({
    period: { ...basePeriod, status: published ? 'published' : 'draft' },
    unitId: 'unit-1',
    readOnly: false,
    published,
    assignments: held,
    nurses: [ana, ben],
    shiftTypes,
  });
  const target = held[0]!;
  return (
    <div>
      <input data-testid="note" />
      {dialog ? <div role="dialog">Reason</div> : null}
      <button type="button" onClick={() => setDialog(true)}>
        open dialog
      </button>
      <button type="button" onClick={() => edits.clearUndo()}>
        clear undo
      </button>
      <button type="button" onClick={() => edits.handleToggleLock(target)}>
        lock
      </button>
      <button type="button" onClick={() => edits.handleToggleOvertime(target)}>
        overtime
      </button>
      {Array.from({ length: 21 }, (_, i) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of test buttons
          key={i}
          type="button"
          onClick={() =>
            edits.handleMove({
              assignmentId: target.id,
              nurseId: target.nurseId,
              shiftTypeId: target.shiftTypeId,
              date: isoDate(`2026-10-${String(6 + i).padStart(2, '0')}`),
            })
          }
        >
          {`move to day ${i}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() =>
          edits.handleMove({
            assignmentId: target.id,
            nurseId: target.nurseId,
            shiftTypeId: target.shiftTypeId,
            date: isoDate('2026-10-06'),
          })
        }
      >
        move
      </button>
      <button
        type="button"
        onClick={() =>
          edits.handleMove({
            assignmentId: held[1]!.id,
            nurseId: held[1]!.nurseId,
            shiftTypeId: held[1]!.shiftTypeId,
            date: isoDate('2026-10-06'),
          })
        }
      >
        move second
      </button>
      <p data-testid="in-flight">
        {edits.pendingCreates.length} ghosts, {edits.pendingIds.size} pending
      </p>
      <button type="button" onClick={() => edits.handleSwap(held[0]!.id, held[1]!.id)}>
        swap
      </button>
      <button type="button" onClick={() => edits.handleRemove(target)}>
        remove
      </button>
      <button type="button" onClick={() => edits.handleToggleCharge(target)}>
        charge
      </button>
      <button
        type="button"
        onClick={() =>
          edits.handleCreate({
            nurseId: ben.id,
            date: isoDate('2026-10-07'),
            shiftTypeId: DAY_12.id,
          })
        }
      >
        add
      </button>
      {edits.pendingEdit ? (
        <button type="button" onClick={() => edits.resolvePendingEdit('Nurse called in sick')}>
          give reason
        </button>
      ) : null}
      {edits.failedEdit ? <p role="alert">failed: {errorMessage(edits.failedEdit.error)}</p> : null}
    </div>
  );
}

async function press(name: string) {
  fireEvent.click(await screen.findByRole('button', { name }));
}

describe('undoing a grid edit', () => {
  it('puts a shift dragged to the wrong day back where it was', async () => {
    bridge.respond('schedule', 'moveAssignment', {
      ...anaMonday,
      id: 'a-new',
      date: isoDate('2026-10-06'),
    });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText('Moved Ana Ruiz to Tue, Oct 6, Day 12');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(2));
    // The first call is the move itself; the undo moves the re-created row (its new id) home.
    expect(bridge.callsTo('schedule', 'moveAssignment')[1]).toEqual([
      { assignmentId: 'a-new', nurseId: 'n-ana', shiftTypeId: 'st-d12', date: '2026-10-05' },
      undefined,
    ]);
  });

  it('swaps two nurses back using the new ids the swap returned', async () => {
    bridge.respond('schedule', 'swapAssignments', [
      { ...anaMonday, id: 'swapped-1' },
      { ...benMonday, id: 'swapped-2' },
    ]);
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('swap');
    await screen.findByText('Swapped Ana Ruiz and Ben Okafor on Mon, Oct 5');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'swapAssignments')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'swapAssignments')[1]).toEqual([
      'swapped-1',
      'swapped-2',
      undefined,
    ]);
  });

  it('brings back a removed shift with its lock, charge and note', async () => {
    const held = assign(ana.id, DAY_12, '2026-10-05', {
      id: 'a-held',
      isLocked: true,
      isCharge: true,
      notes: 'float to 4 West',
    });
    renderWithApp(<Host held={[held, benMonday]} />);
    await press('remove');
    await screen.findByText('Removed Ana Ruiz from Day 12 on Mon, Oct 5');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'createAssignment')).toHaveLength(1));
    expect(bridge.callsTo('schedule', 'createAssignment')[0]).toEqual([
      {
        periodId: 'period-1',
        nurseId: 'n-ana',
        shiftTypeId: 'st-d12',
        date: '2026-10-05',
        isLocked: true,
        isCharge: true,
        isOvertime: false,
        notes: 'float to 4 West',
      },
      undefined,
    ]);
  });

  it('takes a charge nurse designation back off', async () => {
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('charge');
    await screen.findByText('Charge nurse changed');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'updateAssignment')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'updateAssignment')[0]).toEqual([
      'a-ana',
      { isCharge: true },
      undefined,
    ]);
    expect(bridge.callsTo('schedule', 'updateAssignment')[1]).toEqual([
      'a-ana',
      { isCharge: false },
      undefined,
    ]);
  });

  it('tells the change log an undo on a published schedule is an undo of the stated reason', async () => {
    renderWithApp(<Host published held={[anaMonday, benMonday]} />);
    await press('charge');
    await press('give reason');
    await screen.findByText('Charge nurse changed');
    // The reason is not asked for a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'updateAssignment')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'updateAssignment')[0]).toEqual([
      'a-ana',
      { isCharge: true },
      'Nurse called in sick',
    ]);
    expect(bridge.callsTo('schedule', 'updateAssignment')[1]).toEqual([
      'a-ana',
      { isCharge: false },
      'Undo: Nurse called in sick',
    ]);
  });
});

describe('undoing the other kinds of edit', () => {
  it('unlocks a shift the manager just locked', async () => {
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('lock');
    await screen.findByText('Shift locked');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'setLocked')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'setLocked')).toEqual([
      ['a-ana', true],
      ['a-ana', false],
    ]);
  });

  it('takes overtime authorisation back off', async () => {
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('overtime');
    await screen.findByText('Overtime authorisation changed');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'updateAssignment')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'updateAssignment')).toEqual([
      ['a-ana', { isOvertime: true }, undefined],
      ['a-ana', { isOvertime: false }, undefined],
    ]);
  });

  it('quotes the reason when a move on a published schedule is undone', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    renderWithApp(<Host published held={[anaMonday, benMonday]} />);
    await press('move');
    await press('give reason');
    await screen.findByText(/Moved Ana Ruiz/);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(2));
    expect(bridge.callsTo('schedule', 'moveAssignment')[1]![1]).toBe('Undo: Nurse called in sick');
  });

  it('quotes the reason when a removal on a published schedule is undone', async () => {
    renderWithApp(<Host published held={[anaMonday, benMonday]} />);
    await press('remove');
    await press('give reason');
    await screen.findByText(/Removed Ana Ruiz/);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.callsTo('schedule', 'createAssignment')).toHaveLength(1));
    expect(bridge.callsTo('schedule', 'createAssignment')[0]![1]).toBe(
      'Undo: Nurse called in sick',
    );
  });
});

describe('two edits made before the first one lands', () => {
  it('clears both placeholders and keeps both undos when the second lands first', async () => {
    const held: Array<(row: Assignment) => void> = [];
    let calls = 0;
    bridge.respond('schedule', 'moveAssignment', (input) => {
      calls += 1;
      // Only the two drags wait; the undos that follow answer at once.
      if (calls > 2) return { ...anaMonday, id: `undone-${calls}`, date: input.date };
      // The fake bridge resolves with whatever it is handed, a promise included; its scripted type
      // is the synchronous value, hence the cast.
      return new Promise<Assignment>((resolve) => held.push(resolve)) as unknown as Assignment;
    });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await press('move second');
    await waitFor(() => expect(held).toHaveLength(2));
    expect(screen.getByTestId('in-flight').textContent).toBe('2 ghosts, 2 pending');

    held[1]!({ ...benMonday, id: 'b-new', date: isoDate('2026-10-06') });
    held[0]!({ ...anaMonday, id: 'a-new', date: isoDate('2026-10-06') });
    await waitFor(() =>
      expect(screen.getByTestId('in-flight').textContent).toBe('0 ghosts, 0 pending'),
    );

    // Latest recorded first: Ana's move landed last, so it is undone before Ben's.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(3));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(4));
    const [, , undoAna, undoBen] = bridge.callsTo('schedule', 'moveAssignment');
    expect(undoAna).toEqual([
      { assignmentId: 'a-new', nurseId: 'n-ana', shiftTypeId: 'st-d12', date: '2026-10-05' },
      undefined,
    ]);
    expect(undoBen).toEqual([
      { assignmentId: 'b-new', nurseId: 'n-ben', shiftTypeId: 'st-n12', date: '2026-10-05' },
      undefined,
    ]);
  });
});

describe('undoing from the keyboard', () => {
  it('ignores Ctrl-Z while the manager is typing in a field, and undoes once focus leaves it', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText(/Moved Ana Ruiz/);

    const field = screen.getByTestId('note');
    field.focus();
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(1);

    field.blur();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(2));
  });

  it('leaves Ctrl-Z alone while a dialog is open', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText(/Moved Ana Ruiz/);
    await press('open dialog');
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(1);
  });

  it('stops listening once the schedule page is gone', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    const view = renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText(/Moved Ana Ruiz/);
    view.unmount();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(1);
  });

  it('forgets every edit once the undo list is cleared', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText(/Moved Ana Ruiz/);
    await press('clear undo');
    expect(screen.queryByText(/Moved Ana Ruiz/)).toBeNull();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(1);
  });

  it('keeps only the last twenty edits to undo', async () => {
    bridge.respond('schedule', 'moveAssignment', (input) => ({
      ...anaMonday,
      id: `moved-to-${input.date}`,
      date: input.date,
    }));
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    for (let i = 0; i < 21; i++) await press(`move to day ${i}`);
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(21));
    await waitFor(() =>
      expect(screen.getByTestId('in-flight').textContent).toBe('0 ghosts, 0 pending'),
    );
    for (let i = 0; i < 25; i++) fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(41));
    const undone = bridge
      .callsTo('schedule', 'moveAssignment')
      .slice(21)
      .map(([input]) => input.assignmentId);
    // Newest first, and the very first edit (to Oct 6) fell off the end of the list.
    expect(undone[0]).toBe('moved-to-2026-10-26');
    expect(undone[19]).toBe('moved-to-2026-10-07');
    expect(undone).not.toContain('moved-to-2026-10-06');
  });

  it('drops the undo of a move whose cell changed meanwhile, and says so', async () => {
    bridge.respond('schedule', 'moveAssignment', { ...anaMonday, id: 'a-new' });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('move');
    await screen.findByText(/Moved Ana Ruiz/);
    bridge.fail('schedule', 'moveAssignment', new Error('Ana Ruiz already works that day.'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('failed: Ana Ruiz already works that day.');
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'moveAssignment')).toHaveLength(2);
  });

  it('drops an undo that fails, shows why, and does not retry it on the next Ctrl-Z', async () => {
    bridge.respond('schedule', 'createAssignment', { ...anaMonday, id: 'a-added' });
    renderWithApp(<Host held={[anaMonday, benMonday]} />);
    await press('add');
    await screen.findByText(/Added Ben Okafor/);

    bridge.fail('schedule', 'deleteAssignment', new Error('That shift is locked.'));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await screen.findByText('failed: That shift is locked.');
    expect(bridge.callsTo('schedule', 'deleteAssignment')).toEqual([['a-added', undefined]]);

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(bridge.callsTo('schedule', 'deleteAssignment')).toHaveLength(1);
  });
});
