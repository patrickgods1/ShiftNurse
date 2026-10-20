// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePanelFocus } from './use-panel-focus.js';

let setOpenFromOutside: (open: boolean) => void = () => {};

function Editor() {
  const [open, setOpen] = useState(false);
  setOpenFromOutside = setOpen;
  const ref = useRef<HTMLDivElement>(null);
  usePanelFocus(ref, open, () => setOpen(false));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open editor
      </button>
      <input aria-label="Search" />
      {open ? (
        <div ref={ref}>
          <button type="button" disabled>
            Apply
          </button>
          <input aria-label="Census" />
        </div>
      ) : null}
    </>
  );
}

function openEditor(): HTMLElement {
  render(<Editor />);
  const opener = screen.getByRole('button', { name: 'Open editor' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

afterEach(cleanup);

describe('a panel that is not a dialog', () => {
  it('moves focus to the first field the manager can type in, not a disabled button', () => {
    openEditor();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Census' }));
  });

  it('Escape closes the editor and focus goes back to the button that opened it', () => {
    const opener = openEditor();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Census' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Census' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not take focus back from somewhere the manager has since clicked', () => {
    openEditor();
    const search = screen.getByRole('textbox', { name: 'Search' });
    search.focus();
    act(() => setOpenFromOutside(false));
    expect(screen.queryByRole('textbox', { name: 'Census' })).toBeNull();
    expect(document.activeElement).toBe(search);
  });
});
