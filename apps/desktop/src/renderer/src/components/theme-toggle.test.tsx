// @vitest-environment jsdom
/**
 * The header and Settings both mount a theme button; they must agree, and an untouched app must
 * keep following the OS rather than pinning a theme on first paint.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './theme-toggle.js';

let listeners: Array<() => void> = [];
let osDark = false;

function setOsDark(value: boolean): void {
  osDark = value;
  for (const fn of [...listeners]) fn();
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  osDark = false;
  listeners = [];
  window.matchMedia = (() => ({
    get matches() {
      return osDark;
    },
    addEventListener: (_type: string, fn: () => void) => {
      listeners.push(fn);
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

describe('ThemeToggle', () => {
  it('both theme buttons agree after either one is pressed', () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    );
    const [first, second] = screen.getAllByRole('button');
    fireEvent.click(first!);
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-label')).toBe('Switch to light mode');
    }
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.click(second!);
    for (const b of screen.getAllByRole('button')) {
      expect(b.getAttribute('aria-label')).toBe('Switch to dark mode');
    }
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('opening the app with no saved theme leaves the OS in charge', () => {
    render(<ThemeToggle />);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('follows the OS switching to dark while the app is open', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to dark mode');
    act(() => setOsDark(true));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to light mode');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('a saved choice wins over the OS', () => {
    localStorage.setItem('shiftnurse.theme', 'dark');
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to light mode');
    act(() => setOsDark(false));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to light mode');
  });

  it('stops listening to the OS and other windows once no toggle is on screen', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'storage') added.push(type);
      return (realAdd as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'storage') removed.push(type);
      return (realRemove as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.removeEventListener;
    try {
      const first = render(<ThemeToggle />);
      const second = render(<ThemeToggle />);
      expect(listeners).toHaveLength(1);
      expect(added).toHaveLength(1);
      first.unmount();
      expect(listeners).toHaveLength(1);
      second.unmount();
      expect(listeners).toHaveLength(0);
      expect(removed).toHaveLength(1);
      render(<ThemeToggle />);
      expect(listeners).toHaveLength(1);
      expect(added).toHaveLength(2);
    } finally {
      window.addEventListener = realAdd;
      window.removeEventListener = realRemove;
    }
  });

  it('another window choosing dark turns this window dark too', () => {
    render(<ThemeToggle />);
    act(() => {
      localStorage.setItem('shiftnurse.theme', 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: 'shiftnurse.theme' }));
    });
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Switch to light mode');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
