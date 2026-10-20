// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './error-boundary.js';

function Broken(): never {
  throw new Error('Unit missing');
}

const realLocation = window.location;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true });
  vi.restoreAllMocks();
});

describe('the app shell crashing', () => {
  it('a crash in the shell shows what happened and a Reload button, not a blank window', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { reload }, configurable: true });

    render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('ShiftNurse hit a problem showing this screen.');
    expect(alert.textContent).toContain('Unit missing');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    const ours = error.mock.calls.filter(
      (c) => c[0] === '[renderer] the app shell failed to render:',
    );
    expect(ours).toHaveLength(1);
  });
});
