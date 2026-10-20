// @vitest-environment jsdom
/**
 * Generate, then save: the manager asks for a few options, the app offers the best, and saving
 * it is the one step that rewrites the draft. The tests follow each button to what would cross
 * IPC, and check that a batch gone stale cannot be saved.
 */

import type { SolveBatchStatus } from '@shared/api.js';
import type { Assignment, SchedulePeriod, Unit } from '@shiftnurse/core';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorMessage } from '../../components/ui.js';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge.js';
import { renderWithApp } from '../../test/render.js';
import { CandidatesBar } from './candidates-bar.js';
import { GenerateDialog } from './generate-dialog.js';
import { useGenerateFlow } from './use-generate-flow.js';

const unit = { id: 'unit-1' } as Unit;
const period = {
  id: 'p-1',
  unitId: 'unit-1',
  name: 'Autumn',
  startDate: '2026-10-04',
  endDate: '2026-11-14',
  status: 'draft',
} as SchedulePeriod;

const digest = {
  nights: { min: 2, max: 3 },
  weekends: { min: 1, max: 2 },
  quickFlips: 0,
  nursesUnderContract: 0,
  againstPreference: 0,
  onDaysAskedOff: 0,
};

function run(index: number, objective: number) {
  return {
    index,
    seed: index,
    solver: 'sa-lns' as const,
    state: 'done' as const,
    summary: {
      objective,
      digest,
      floorsShort: 0,
      unfilledSlots: 0,
      unfilled: [],
      hardViolations: 0,
      softViolations: 0,
      elapsedMs: 1,
    },
  };
}

const finishedBatch: SolveBatchStatus = {
  id: 'batch-1',
  periodId: 'p-1',
  solver: 'sa-lns',
  state: 'done',
  cancelled: false,
  count: 2,
  offset: 0,
  concurrency: 1,
  startedAt: 0,
  runs: [run(0, 200), run(1, 100)],
};

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.respond('shiftTypes', 'list', []);
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

const shifts = (locked: boolean[]) =>
  locked.map((isLocked, i) => ({ id: `a-${i}`, isLocked })) as unknown as Assignment[];

/** The board's wiring of the flow hook to the bar, minus the grid. */
function Bar({ assignments }: { assignments: Assignment[] }) {
  const flow = useGenerateFlow({ period, unitId: 'unit-1', assignments });
  if (!flow.batch) return null;
  return (
    <CandidatesBar
      batch={flow.batch}
      selected={flow.selectedIndex}
      onSelect={flow.setChosenIndex}
      previewing={flow.previewActive}
      onTogglePreview={() => {}}
      onCompare={() => {}}
      onSave={() => void flow.handleSaveCandidate()}
      onDiscard={() => flow.discardBatch.mutate(flow.batch!.id)}
      onCancel={() => {}}
      onShowProgress={() => {}}
      saving={flow.saveCandidate.isPending}
      error={flow.saveCandidate.isError ? errorMessage(flow.saveCandidate.error) : undefined}
    />
  );
}

function renderBar(batch: SolveBatchStatus, assignments: Assignment[]) {
  bridge.respond('solver', 'current', batch);
  bridge.respond('solver', 'save', { created: 2, preservedLocked: 0 });
  renderWithApp(<Bar assignments={assignments} />, { unit });
}

describe('asking Generate for options', () => {
  function renderDialog(batch: SolveBatchStatus | null = null) {
    bridge.respond('solver', 'estimate', {
      count: 5,
      concurrency: 1,
      totalMs: 30_000,
      basis: 'rough',
      solver: 'sa-lns',
    } as never);
    bridge.respond('solver', 'start', { ...finishedBatch, state: 'running' });
    bridge.respond('solverSettings', 'get', { solverId: 'hybrid' } as never);
    renderWithApp(
      <GenerateDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        period={period}
        lockedCount={0}
        unlockedCount={0}
        undecidedRequests={0}
        batch={batch}
        view="setup"
        onViewChange={() => {}}
        onCompare={() => {}}
        onPreview={() => {}}
      />,
    );
  }

  it('starts the number of options the manager chose with the search method they picked', async () => {
    renderDialog();
    fireEvent.change(await screen.findByTestId('generate-count'), { target: { value: '5' } });
    await waitFor(() =>
      expect((screen.getByTestId('generate-solver') as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByTestId('generate-solver'), { target: { value: 'sa-lns' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate 5 options' }));
    await waitFor(() =>
      expect(bridge.callsTo('solver', 'start')).toEqual([['p-1', { count: 5, solver: 'sa-lns' }]]),
    );
  });

  it('lets the manager clear the number of options and type a new one', async () => {
    renderDialog();
    const field = (await screen.findByTestId('generate-count')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '' } });
    expect(field.value).toBe('');
    expect((screen.getByTestId('generate-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Enter a whole number from 1 to 10.')).toBeTruthy();
    fireEvent.change(field, { target: { value: '5' } });
    expect(field.value).toBe('5');
    const generate = screen.getByTestId('generate-confirm') as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    fireEvent.click(generate);
    await waitFor(() => expect(bridge.callsTo('solver', 'start')).toEqual([['p-1', { count: 5 }]]));
  });

  it('brings 15 down to 10 when the manager leaves the field', async () => {
    renderDialog();
    const field = (await screen.findByTestId('generate-count')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '15' } });
    expect(field.value).toBe('15');
    fireEvent.blur(field);
    expect(field.value).toBe('10');
  });

  it('puts the last good number back when the manager leaves the field blank', async () => {
    renderDialog();
    const field = (await screen.findByTestId('generate-count')) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(field.value).toBe('4');
  });

  it('leaves the search method to the unit default when the manager does not pick one', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate 3 options' }));
    await waitFor(() => expect(bridge.callsTo('solver', 'start')).toEqual([['p-1', { count: 3 }]]));
  });

  it('carries on after the last batch so the new options are ones not yet tried', async () => {
    renderDialog(finishedBatch);
    fireEvent.click(await screen.findByRole('button', { name: 'Generate 3 more' }));
    await waitFor(() =>
      expect(bridge.callsTo('solver', 'start')).toEqual([
        ['p-1', { count: 3, continueAfter: 'batch-1' }],
      ]),
    );
  });

  it('says why when the batch could not be started', async () => {
    renderDialog();
    bridge.fail('solver', 'start', new Error('Another schedule is being generated.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Generate 3 options' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Another schedule is being generated.',
    );
  });

  it('stops a running Generate when the manager presses Stop', async () => {
    bridge.respond('solver', 'cancel', undefined as never);
    renderDialog({ ...finishedBatch, state: 'running', runs: [run(0, 200)] });

    fireEvent.click(await screen.findByTestId('generate-cancel'));

    await waitFor(() => expect(bridge.callsTo('solver', 'cancel')).toEqual([['batch-1']]));
  });
});

describe('the Generate summary', () => {
  it('says in the summary why options 1 and 3 ran SA + LNS', async () => {
    const reason =
      'CP-SAT found no schedule around the locked shifts: unlock Ana Cruz Mon Jan 5 N12';
    const fell = { solver: 'cp-sat' as const, reason };
    const batch: SolveBatchStatus = {
      ...finishedBatch,
      count: 3,
      runs: [
        { ...run(0, 100), fellBackFrom: fell },
        run(1, 110),
        { ...run(2, 120), fellBackFrom: fell },
      ],
    };
    renderWithApp(
      <GenerateDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        period={period}
        lockedCount={0}
        unlockedCount={0}
        undecidedRequests={0}
        batch={batch}
        view="batch"
        onViewChange={() => {}}
        onCompare={() => {}}
        onPreview={() => {}}
      />,
    );
    const note = await screen.findByTestId('generate-run-fallback');
    expect(note.textContent?.startsWith('Options 1, 3: Ran Fastest instead of Exhaustive:')).toBe(
      true,
    );
    expect(note.textContent).toContain('unlock Ana Cruz');
  });
});

describe('the Generate progress', () => {
  it('announces how many options are done politely', async () => {
    const running: SolveBatchStatus = {
      ...finishedBatch,
      state: 'running',
      runs: [run(0, 100), { ...run(1, 0), state: 'running' as const }],
    };
    renderWithApp(
      <GenerateDialog
        open
        onOpenChange={() => {}}
        unitId="unit-1"
        period={period}
        lockedCount={0}
        unlockedCount={0}
        undecidedRequests={0}
        batch={running}
        view="batch"
        onViewChange={() => {}}
        onCompare={() => {}}
        onPreview={() => {}}
      />,
    );
    const text = await screen.findByText('1 of 2 done');
    expect(text.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      '1 of 2 options done',
    );
  });
});

describe('saving the option the manager picked as the draft', () => {
  it('offers the best option and saves it after confirming it replaces the unlocked shifts', async () => {
    renderBar(finishedBatch, shifts([false, false, true]));
    // Option 2 scored 100 against option 1's 200.
    expect((await screen.findByTestId('candidate-position')).textContent).toContain('Option 2');
    expect(screen.getByText('Best overall')).toBeTruthy();

    fireEvent.click(screen.getByTestId('candidate-save'));
    expect(await screen.findByText(/replaces the 2 unlocked shifts/)).toBeTruthy();
    expect(bridge.callsTo('solver', 'save')).toEqual([]);
    fireEvent.click(screen.getByTestId('confirm-accept'));

    await waitFor(() => expect(bridge.callsTo('solver', 'save')).toEqual([['batch-1', 1]]));
  });

  it('saves the option the manager paged to, not the best one', async () => {
    renderBar(finishedBatch, shifts([false]));
    await screen.findByTestId('candidates-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Previous option' }));
    fireEvent.click(screen.getByTestId('candidate-save'));
    fireEvent.click(await screen.findByTestId('confirm-accept'));
    await waitFor(() => expect(bridge.callsTo('solver', 'save')).toEqual([['batch-1', 0]]));
  });

  it('keeps the draft when the manager backs out of the confirmation', async () => {
    renderBar(finishedBatch, shifts([false]));
    fireEvent.click(await screen.findByTestId('candidate-save'));
    await screen.findByTestId('confirm-accept');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('confirm-accept')).toBeNull());
    expect(bridge.callsTo('solver', 'save')).toEqual([]);
  });

  it('saves without a second question when every shift on the grid is locked', async () => {
    renderBar(finishedBatch, shifts([true, true]));
    fireEvent.click(await screen.findByTestId('candidate-save'));
    await waitFor(() => expect(bridge.callsTo('solver', 'save')).toEqual([['batch-1', 1]]));
    expect(screen.queryByTestId('confirm-accept')).toBeNull();
  });

  it('shows the reason when saving is refused', async () => {
    renderBar(finishedBatch, shifts([]));
    bridge.fail('solver', 'save', new Error('The period was published since these were made.'));
    fireEvent.click(await screen.findByTestId('candidate-save'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The period was published since these were made.',
    );
  });
});

describe('options made against a schedule that has since changed', () => {
  it('says they are out of date and offers no way to save them', async () => {
    renderBar({ ...finishedBatch, stale: 'a time-off request was approved' }, shifts([false]));
    expect(
      await screen.findByText(/These options are out of date: a time-off request was approved/),
    ).toBeTruthy();
    expect(screen.queryByTestId('candidate-save')).toBeNull();
    expect(screen.queryByText('Save this schedule')).toBeNull();
    expect(bridge.callsTo('solver', 'save')).toEqual([]);
  });
});
