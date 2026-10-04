// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge.js';
import { renderWithApp } from '../test/render.js';
import { EditorShell } from './editor-shell.js';
import { useConfirmDiscard } from './unsaved-changes.js';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

function shell(props: Partial<Parameters<typeof EditorShell>[0]> = {}) {
  return (
    <EditorShell label="Pay" dirty={false} onSave={() => {}} onDiscard={() => {}} {...props}>
      <p>form</p>
    </EditorShell>
  );
}

describe('EditorShell', () => {
  it('keeps Save and Discard off until something is edited', async () => {
    renderWithApp(shell());
    expect(
      ((await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('saves and discards when there are edits', async () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    renderWithApp(shell({ dirty: true, onSave, onDiscard, saveLabel: 'Save policy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save policy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('says Saving while the save runs and blocks a second press', async () => {
    renderWithApp(shell({ dirty: true, saving: true }));
    const button = (await screen.findByRole('button', { name: 'Saving…' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows why the save failed', async () => {
    renderWithApp(shell({ dirty: true, error: new Error('Rate must be positive') }));
    expect((await screen.findByRole('alert')).textContent).toBe('Rate must be positive');
  });

  it('holds Save back while the form is invalid', async () => {
    renderWithApp(shell({ dirty: true, canSave: false }));
    expect(
      ((await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('tells the unsaved-changes guard which editor has edits', async () => {
    function Probe() {
      const confirmDiscard = useConfirmDiscard();
      return (
        <button type="button" onClick={() => void confirmDiscard()}>
          leave
        </button>
      );
    }
    renderWithApp(
      <>
        {shell({ dirty: true })}
        <Probe />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'leave' }));
    expect(await screen.findByText('Discard unsaved changes to Pay?')).toBeTruthy();
  });

  it('keeps Discard off while the save runs', async () => {
    renderWithApp(shell({ dirty: true, saving: true }));
    expect(
      ((await screen.findByRole('button', { name: 'Discard' })) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('saves when the manager presses Enter in a field of its form', async () => {
    const onSave = vi.fn();
    renderWithApp(
      <EditorShell label="Pay" dirty onSave={onSave} onDiscard={() => {}} formId="pay-form">
        <form
          id="pay-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <input aria-label="Rate" />
        </form>
      </EditorShell>,
    );
    const save = (await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement;
    expect(save.type).toBe('submit');
    expect(save.getAttribute('form')).toBe('pay-form');
    // jsdom implements implicit submission through the form's default button.
    fireEvent.submit(screen.getByLabelText('Rate').closest('form') as HTMLFormElement);
    expect(onSave).toHaveBeenCalledOnce();
  });
});
