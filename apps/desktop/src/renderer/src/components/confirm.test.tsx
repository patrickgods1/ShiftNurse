// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfirmOptions, ConfirmProvider, useConfirm } from './confirm.js';
import { ToastProvider, toastBus } from './toast.js';

let ask: (options: ConfirmOptions) => Promise<boolean> = () => Promise.resolve(false);

function RemovePayRate() {
  const confirm = useConfirm();
  ask = confirm;
  const [answer, setAnswer] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          // Cleared per question, so a second "false" is a new answer and not the first one left over.
          setAnswer('');
          const yes = await confirm({ title: 'Delete this pay rate?', confirmLabel: 'Delete' });
          setAnswer(String(yes));
        }}
      >
        Remove pay rate
      </button>
      <output data-testid="answer">{answer}</output>
    </>
  );
}

function mount() {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <RemovePayRate />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

const answer = () => screen.getByTestId('answer').textContent;

async function askToRemove(): Promise<HTMLElement> {
  const button = screen.getByRole('button', { name: 'Remove pay rate' });
  button.focus();
  fireEvent.click(button);
  await screen.findByRole('alertdialog');
  return button;
}

afterEach(cleanup);

describe('the confirmation question', () => {
  it('answers yes when the manager presses the named button', async () => {
    mount();
    await askToRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(answer()).toBe('true'));
  });

  it('answers no on Cancel and on Escape', async () => {
    mount();
    await askToRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answer()).toBe('false'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await askToRemove();
    expect(answer()).toBe('');
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(answer()).toBe('false'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('puts focus back on the button that asked', async () => {
    mount();
    const button = await askToRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('a second question answers the first one no', async () => {
    mount();
    let first: Promise<boolean> | undefined;
    act(() => {
      first = ask({ title: 'Delete this pay rate?' });
    });
    act(() => void ask({ title: 'Remove this assignment?' }));
    await expect(first).resolves.toBe(false);
    expect(
      within(screen.getByRole('alertdialog')).getByText('Remove this assignment?', {
        selector: 'h2',
      }),
    ).toBeTruthy();
  });

  it('shows a failure toast inside the open question, and dismissing it leaves the question open', async () => {
    mount();
    await askToRemove();
    act(() => toastBus.emit({ message: 'Could not save the pay rate', tone: 'error' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Could not save the pay rate')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    // Give an outside-interaction close every chance to happen before checking it did not.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(answer()).toBe('');
  });

  it('puts focus back on the button that asked after the manager confirms', async () => {
    mount();
    const button = await askToRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(answer()).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('sends focus to the neighbour the question names when the button that asked is gone', async () => {
    // Deleting the chip removes the control that asked, so the question names the grid cell.
    function DeleteChip() {
      const confirm = useConfirm();
      const [chipShown, setChipShown] = useState(true);
      const cell = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={cell}>
            Alice, Monday
          </button>
          {chipShown ? (
            <button
              type="button"
              onClick={async () => {
                const yes = await confirm({
                  title: 'Remove this assignment?',
                  confirmLabel: 'Remove',
                  returnFocus: () => cell.current,
                });
                if (yes) setChipShown(false);
              }}
            >
              Day shift
            </button>
          ) : null}
        </>
      );
    }
    render(
      <ToastProvider>
        <ConfirmProvider>
          <DeleteChip />
        </ConfirmProvider>
      </ToastProvider>,
    );
    const chip = screen.getByRole('button', { name: 'Day shift' });
    chip.focus();
    fireEvent.click(chip);
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Day shift' })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Alice, Monday' })),
    );
  });
});
