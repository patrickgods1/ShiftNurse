// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider, useConfirm } from './confirm.js';
import { Modal, type ModalProps } from './modal.js';
import { type ToastApi, ToastProvider, useToast } from './toast.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(props: Partial<ModalProps> = {}) {
  return render(
    <ToastProvider>
      <Modal open onOpenChange={() => {}} title="Anything" {...props}>
        <p>Body text</p>
      </Modal>
    </ToastProvider>,
  );
}

describe('Modal', () => {
  it('shows the title, description, body and action row', () => {
    open({
      title: 'Publish week',
      description: 'Freezes this version.',
      footer: <button type="button">Publish</button>,
      'data-testid': 'the-modal',
    });
    expect(screen.getByRole('dialog', { name: 'Publish week' })).toBeTruthy();
    expect(screen.getByTestId('the-modal')).toBeTruthy();
    expect(screen.getByText('Freezes this version.')).toBeTruthy();
    expect(screen.getByText('Body text')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });

  it('asks to close when the manager presses Escape', () => {
    const onOpenChange = vi.fn();
    open({ onOpenChange });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when the dialog vetoes Escape', () => {
    const onOpenChange = vi.fn();
    const onEscapeKeyDown = vi.fn((e: KeyboardEvent) => e.preventDefault());
    open({ onOpenChange, onEscapeKeyDown });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onEscapeKeyDown).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('lets a dialog veto a click outside', async () => {
    const onOpenChange = vi.fn();
    const onInteractOutside = vi.fn((e: Event) => e.preventDefault());
    open({ onOpenChange, onInteractOutside });
    // Radix starts listening for outside clicks a tick after it opens.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const down = new MouseEvent('pointerdown', { bubbles: true });
    Object.assign(down, { pointerType: 'mouse' });
    outside.dispatchEvent(down);
    // Radix defers a primary-button outside press until the click that completes it.
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onInteractOutside).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    open({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('describes the dialog by its description when it has one', () => {
    open({ description: 'Freezes this version.' });
    const dialog = screen.getByRole('dialog');
    const id = dialog.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)?.textContent).toBe('Freezes this version.');
  });

  it('has no description reference when it has none', () => {
    open();
    expect(screen.getByRole('dialog').hasAttribute('aria-describedby')).toBe(false);
  });

  it('does not make Radix warn, with or without a description', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    open();
    cleanup();
    open({ description: 'Why.' });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('scrolls a tall popup instead of running off the screen', () => {
    open({ variant: 'popup', size: 'sm' });
    const cls = screen.getByRole('dialog').className;
    expect(cls).toContain('overflow-y-auto');
    expect(cls).toContain('w-[360px]');
  });

  it('shows a toast raised while it is open inside the dialog', () => {
    let toast: ToastApi | undefined;
    function Grab() {
      toast = useToast();
      return null;
    }
    render(
      <ToastProvider>
        <Grab />
        <Modal open onOpenChange={() => {}} title="Anything">
          <p>Body</p>
        </Modal>
      </ToastProvider>,
    );
    act(() => void toast?.show({ message: 'Backup created.' }));
    const note = screen.getByText('Backup created.');
    expect(screen.getByRole('dialog').contains(note)).toBe(true);
  });
});

/**
 * A shift editor opened from a button, the way every dialog here opens: from state, with no
 * Radix trigger. "Delete" removes the opener as well as closing, like deleting the chip it edits.
 */
function Opener({
  withReturnFocus = false,
  mountWhenOpen = false,
}: {
  withReturnFocus?: boolean;
  /** Mounts the Modal only while open, as many dialogs do, so StrictMode re-runs its effects. */
  mountWhenOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openerShown, setOpenerShown] = useState(true);
  const back = useRef<HTMLButtonElement>(null);
  return (
    <ToastProvider>
      <button type="button" ref={back}>
        Back to the grid
      </button>
      {openerShown ? (
        <button type="button" onClick={() => setOpen(true)}>
          Edit shift
        </button>
      ) : null}
      {!mountWhenOpen || open ? (
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Edit shift"
          {...(withReturnFocus ? { returnFocus: () => back.current } : {})}
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpenerShown(false);
                  setOpen(false);
                }}
              >
                Delete
              </button>
            </>
          }
        />
      ) : null}
    </ToastProvider>
  );
}

async function openShiftEditor(): Promise<HTMLElement> {
  const opener = screen.getByRole('button', { name: 'Edit shift' });
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole('dialog');
}

describe('Modal focus return', () => {
  it('puts focus back on the button that opened it when the manager cancels', async () => {
    render(<Opener />);
    await openShiftEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit shift' })),
    );
  });

  it('puts focus back on the opener after Escape', async () => {
    render(<Opener />);
    const dialog = await openShiftEditor();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit shift' })),
    );
  });

  it('sends focus where the dialog says when the opener is gone', async () => {
    render(<Opener withReturnFocus />);
    await openShiftEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back to the grid' })),
    );
  });

  it('leaves focus alone without crashing when the opener is gone and nothing is named', async () => {
    render(<Opener />);
    await openShiftEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // FocusScope's close runs a tick after unmount; let it, then check nothing moved focus.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(document.body);
  });

  it('puts focus back on the opener under StrictMode, which runs the capture twice', async () => {
    // StrictMode re-runs a mounting component's effects after focus has already moved inside the
    // dialog; that second run must not take the dialog's own first field for the opener.
    render(
      <StrictMode>
        <Opener mountWhenOpen />
      </StrictMode>,
    );
    await openShiftEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit shift' })),
    );
  });

  it('puts focus back on the button inside the dialog when a question it asked is cancelled', async () => {
    function EditNurse() {
      const confirm = useConfirm();
      return (
        <Modal open onOpenChange={() => {}} title="Edit nurse">
          <button type="button" onClick={() => void confirm({ title: 'Remove this nurse?' })}>
            Remove
          </button>
        </Modal>
      );
    }
    render(
      <ToastProvider>
        <ConfirmProvider>
          <EditNurse />
        </ConfirmProvider>
      </ToastProvider>,
    );
    const remove = await screen.findByRole('button', { name: 'Remove' });
    remove.focus();
    fireEvent.click(remove);
    const question = await screen.findByRole('alertdialog');
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(remove));
  });
});
