// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ToastApi, ToastOutlet, ToastProvider, toastBus, useToast } from './toast.js';

let toast: ToastApi;
function Grab() {
  toast = useToast();
  return null;
}

function mount() {
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toasts', () => {
  it('tells the manager a save failed and clears it after ten seconds', () => {
    mount();
    act(() => void toast.show({ message: 'Could not save the rule set.', tone: 'error' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not save the rule set.');
    act(() => void vi.advanceTimersByTime(9_999));
    expect(screen.queryByRole('alert')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears an info notice after six seconds', () => {
    mount();
    act(() => void toast.show({ message: 'Backup created.' }));
    expect(screen.getByRole('status').textContent).toContain('Backup created.');
    act(() => void vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a toast up while the pointer rests on it and finishes the remaining time after', () => {
    mount();
    act(() => void toast.show({ message: 'Held', durationMs: 1_000 }));
    act(() => void vi.advanceTimersByTime(600));
    const item = screen.getByRole('status');
    fireEvent.mouseEnter(item);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole('status')).not.toBeNull();
    fireEvent.mouseLeave(item);
    act(() => void vi.advanceTimersByTime(399));
    expect(screen.queryByRole('status')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('runs the action and then dismisses the toast', () => {
    mount();
    const onClick = vi.fn();
    act(() => void toast.show({ message: 'Removed', action: { label: 'Undo', onClick } }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses the focused toast on Escape', () => {
    mount();
    act(() => void toast.show({ message: 'Escape me' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss' }), { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows at most three and drops the oldest', () => {
    mount();
    act(() => {
      for (const n of [1, 2, 3, 4]) toast.show({ message: `Notice ${n}` });
    });
    expect(screen.queryByText('Notice 1')).toBeNull();
    expect(screen.getAllByRole('status').map((e) => e.textContent?.slice(0, 8))).toEqual([
      'Notice 2',
      'Notice 3',
      'Notice 4',
    ]);
  });

  it('shows what code outside React emits on the bus', () => {
    mount();
    act(() => toastBus.emit({ message: 'From the query client', tone: 'error' }));
    expect(screen.getByRole('alert').textContent).toContain('From the query client');
  });

  it('draws a toast once when two outlets are mounted, and the global region steps aside', () => {
    render(
      <ToastProvider>
        <Grab />
        <ToastOutlet />
        <ToastOutlet />
      </ToastProvider>,
    );
    act(() => void toast.show({ message: 'Once only' }));
    expect(screen.getAllByText('Once only')).toHaveLength(1);
  });

  it('goes back to the global region when the last outlet unmounts', () => {
    function Host({ withOutlet }: { withOutlet: boolean }) {
      return (
        <ToastProvider>
          <Grab />
          {withOutlet ? (
            <div data-testid="dialog">
              <ToastOutlet />
            </div>
          ) : null}
        </ToastProvider>
      );
    }
    const { rerender } = render(<Host withOutlet />);
    act(() => void toast.show({ message: 'Inside' }));
    expect(screen.getByTestId('dialog').textContent).toContain('Inside');
    rerender(<Host withOutlet={false} />);
    expect(screen.getAllByText('Inside')).toHaveLength(1);
    expect(screen.queryByTestId('dialog')).toBeNull();
  });
});
