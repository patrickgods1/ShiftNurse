// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { firstFocusable, isFocusable, restoreFocus } from './focus.js';

function container(html: string): HTMLDivElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keyboard focus helpers', () => {
  it('skips a disabled Save button and lands on the first field the manager can use', () => {
    const div = container('<button disabled>Save</button><input aria-label="Census">');
    expect(firstFocusable(div)).toBe(div.querySelector('input'));
  });

  it('counts a link as a place focus can go', () => {
    const div = container('<a href="#x">Open the nurse</a><button>Close</button>');
    expect(firstFocusable(div)).toBe(div.querySelector('a'));
  });

  it('does not try to focus a shift chip that has been removed from the page', () => {
    const removed = document.createElement('button');
    document.body.appendChild(removed);
    removed.remove();
    const fallback = document.createElement('button');
    document.body.appendChild(fallback);

    expect(restoreFocus(removed, fallback)).toBe(true);
    expect(document.activeElement).toBe(fallback);

    expect(restoreFocus(removed)).toBe(false);
    expect(document.activeElement).toBe(fallback);
  });

  it('can put focus back on a grid cell that is not the roving tab stop', () => {
    const div = container('<div tabindex="-1">Mon 5</div>');
    expect(isFocusable(div.firstElementChild)).toBe(true);
  });
});
