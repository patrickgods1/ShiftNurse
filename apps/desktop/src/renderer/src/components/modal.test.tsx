// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
